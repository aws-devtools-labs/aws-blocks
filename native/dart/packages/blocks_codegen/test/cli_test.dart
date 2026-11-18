// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

final _packageRoot = Directory.current.absolute.path;

ProcessResult _run(List<String> args, {String? workingDirectory}) =>
    Process.runSync(Platform.resolvedExecutable, [
      'run',
      '$_packageRoot/bin/blocks_codegen.dart',
      ...args,
    ], workingDirectory: workingDirectory ?? _packageRoot);

const _tag = 'example-iot/device-link';

String _spec({String? pattern}) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'cli', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.getDevice',
      'params': pattern == null
          ? <Map<String, dynamic>>[]
          : [
              {
                'name': 'id',
                'required': true,
                'schema': {'type': 'string', 'pattern': pattern},
              },
            ],
      'result': {
        'name': 'GetDeviceResult',
        'schema': {'x-blocks-transferable': _tag},
      },
    },
  ],
  'x-blocks-native-packages': {
    'schemaVersion': 1,
    'packages': {
      'example-iot-native': {
        'platforms': {
          'dart': {
            'package': {
              'name': 'example_iot_native',
              'library': 'example_iot_native.dart',
            },
          },
        },
      },
    },
  },
  'x-blocks-native-bindings': {
    'schemaVersion': 1,
    'bindings': [
      {
        'id': 'example-iot/device-link',
        'kind': 'transferable',
        'tag': _tag,
        'package': 'example-iot-native',
        'export': 'deviceLink',
        'abi': 'blocks-transferable-v1',
        'genericArity': 0,
      },
    ],
  },
});

String _tupleSpec() => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'tuple', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.getPair',
      'params': <Object?>[],
      'result': {
        'name': 'GetPairResult',
        'schema': {
          'type': 'array',
          'prefixItems': [
            {'type': 'string'},
            {'type': 'integer'},
          ],
        },
      },
    },
  ],
});

typedef _ConfigPackage = ({
  String name,
  Directory root,
  String? languageVersion,
});

void _writePackageConfig(
  Directory discoveryRoot,
  List<_ConfigPackage> packages,
) {
  final dartTool = Directory('${discoveryRoot.path}/.dart_tool')..createSync();
  File('${dartTool.path}/package_config.json').writeAsStringSync(
    jsonEncode({
      'configVersion': 2,
      'packages': [
        for (final package in packages)
          {
            'name': package.name,
            'rootUri': package.root.absolute.uri.toString(),
            'packageUri': 'lib/',
            'languageVersion': ?package.languageVersion,
          },
      ],
    }),
  );
}

void main() {
  late Directory tmp;

  setUp(() => tmp = Directory.systemTemp.createTempSync('blocks_cli_test'));
  tearDown(() => tmp.deleteSync(recursive: true));

  String writeSpec(String contents) {
    final f = File('${tmp.path}/spec.json')..writeAsStringSync(contents);
    return f.path;
  }

  group('blocks_codegen CLI', () {
    test('binds a declared package by default', () {
      final result = _run(['--spec', writeSpec(_spec())]);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(result.stdout, contains('Future<DeviceLink> getDevice()'));
      expect(
        result.stdout,
        contains("import 'package:example_iot_native/example_iot_native.dart'"),
      );
    });

    test('--native-package-opt-out drops that package\'s bindings', () {
      final result = _run([
        '--spec',
        writeSpec(_spec()),
        '--native-package-opt-out',
        'example-iot-native',
      ]);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(result.stdout, contains('Future<UnknownTransferable>'));
      expect(result.stdout, isNot(contains('DeviceLink')));
    });

    test('a repeated --native-package-opt-out collects every value', () {
      // Both orders, so neither first-value-only nor last-value-only passes.
      for (final order in [
        ['other-native', 'example-iot-native'],
        ['example-iot-native', 'other-native'],
      ]) {
        final result = _run([
          '--spec',
          writeSpec(_spec()),
          '--native-package-opt-out',
          order[0],
          '--native-package-opt-out',
          order[1],
        ]);

        expect(result.exitCode, 0, reason: result.stderr.toString());
        expect(result.stdout, contains('Future<UnknownTransferable>'));
        expect(result.stdout, isNot(contains('DeviceLink')));
      }
    });

    test('resolves output below nonexistent directories', () {
      final target = Directory('${tmp.path}/target')..createSync();
      _writePackageConfig(target, [
        (name: 'target', root: target, languageVersion: '3.11'),
      ]);
      final outputPath = '${target.path}/missing/nested/client.dart';

      final result = _run([
        '--spec',
        writeSpec(_tupleSpec()),
        '--output',
        outputPath,
      ], workingDirectory: tmp.path);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(
        File(outputPath).readAsStringSync(),
        startsWith('// dart format width=80\n'),
      );
    });

    test('prefers the output package language version over cwd', () {
      final cwd = Directory('${tmp.path}/cwd')..createSync();
      final target = Directory('${tmp.path}/target')..createSync();
      _writePackageConfig(cwd, [
        (name: 'cwd', root: cwd, languageVersion: '2.19'),
      ]);
      _writePackageConfig(target, [
        (name: 'target', root: target, languageVersion: '3.11'),
      ]);
      final outputPath = '${target.path}/lib/client.dart';

      final result = _run([
        '--spec',
        writeSpec(_tupleSpec()),
        '--output',
        outputPath,
      ], workingDirectory: cwd.path);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(File(outputPath).existsSync(), isTrue);
    });

    test(
      'falls back to cwd config only when output config cannot map target',
      () {
        final cwd = Directory('${tmp.path}/cwd')..createSync();
        final target = Directory('${tmp.path}/target')..createSync();
        final unrelated = Directory('${tmp.path}/unrelated')..createSync();
        _writePackageConfig(target, [
          (name: 'unrelated', root: unrelated, languageVersion: '2.19'),
        ]);
        _writePackageConfig(cwd, [
          (name: 'cwd', root: cwd, languageVersion: '2.19'),
          (name: 'target', root: target, languageVersion: '3.11'),
        ]);
        final outputPath = '${target.path}/lib/client.dart';

        final result = _run([
          '--spec',
          writeSpec(_tupleSpec()),
          '--output',
          outputPath,
        ], workingDirectory: cwd.path);

        expect(result.exitCode, 0, reason: result.stderr.toString());
        expect(File(outputPath).existsSync(), isTrue);
      },
    );

    test('uses the cwd package language version for stdout', () {
      final cwd = Directory('${tmp.path}/cwd')..createSync();
      _writePackageConfig(cwd, [
        (name: 'cwd', root: cwd, languageVersion: '3.11'),
      ]);

      final result = _run([
        '--spec',
        writeSpec(_tupleSpec()),
      ], workingDirectory: cwd.path);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(result.stdout, startsWith('// dart format width=80\n'));
    });

    test('uses Dart 3.11 when a mapped target has no language version', () {
      final cwd = Directory('${tmp.path}/cwd')..createSync();
      final target = Directory('${tmp.path}/target')..createSync();
      _writePackageConfig(target, [
        (name: 'target', root: target, languageVersion: null),
      ]);
      _writePackageConfig(cwd, [
        (name: 'cwd', root: cwd, languageVersion: '3.11'),
        (name: 'target', root: target, languageVersion: '2.19'),
      ]);
      final outputPath = '${target.path}/lib/client.dart';

      final result = _run([
        '--spec',
        writeSpec(_tupleSpec()),
        '--output',
        outputPath,
      ], workingDirectory: cwd.path);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(File(outputPath).existsSync(), isTrue);
    });

    test('uses Dart 3.11 when no package config exists', () {
      final cwd = Directory('${tmp.path}/no_config')..createSync();

      final result = _run([
        '--spec',
        writeSpec(_tupleSpec()),
      ], workingDirectory: cwd.path);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(result.stdout, startsWith('// dart format width=80\n'));
    });

    test('formatter failure leaves an existing output unchanged', () {
      final target = Directory('${tmp.path}/target')..createSync();
      _writePackageConfig(target, [
        (name: 'target', root: target, languageVersion: '2.19'),
      ]);
      final output = File('${target.path}/client.dart')
        ..writeAsStringSync('sentinel');

      final result = _run([
        '--spec',
        writeSpec(_tupleSpec()),
        '--output',
        output.path,
      ], workingDirectory: tmp.path);

      expect(result.exitCode, 1);
      expect(result.stderr, startsWith('Error:'));
      expect(result.stdout, isEmpty);
      expect(output.readAsStringSync(), 'sentinel');
    });

    test('malformed output package config is reported without writing', () {
      final target = Directory('${tmp.path}/target')..createSync();
      final dartTool = Directory('${target.path}/.dart_tool')..createSync();
      File('${dartTool.path}/package_config.json').writeAsStringSync('{');
      final output = File('${target.path}/client.dart')
        ..writeAsStringSync('sentinel');

      final result = _run([
        '--spec',
        writeSpec(_spec()),
        '--output',
        output.path,
      ], workingDirectory: tmp.path);

      expect(result.exitCode, 1);
      expect(result.stderr, startsWith('Error:'));
      expect(result.stdout, isEmpty);
      expect(output.readAsStringSync(), 'sentinel');
    });

    test('a spec the parser rejects exits 1 with the message', () {
      final result = _run(['--spec', writeSpec(_spec(pattern: r'abc\'))]);

      expect(result.exitCode, 1);
      expect(result.stderr, contains('Error:'));
      expect(result.stderr, contains('regular expression'));
      expect(result.stdout, isEmpty);
    });

    test('an unknown flag exits 1 with usage', () {
      final result = _run(['--spec', writeSpec(_spec()), '--no-such-flag']);

      expect(result.exitCode, 1);
      expect(result.stderr, contains('Could not find an option named'));
      expect(result.stderr, contains('--native-package-opt-out'));
      expect(result.stdout, isEmpty);
    });

    test('an empty --native-package-opt-out value exits 1', () {
      final result = _run([
        '--spec',
        writeSpec(_spec()),
        '--native-package-opt-out',
        '',
      ]);

      expect(result.exitCode, 1);
      expect(result.stderr, contains('requires a package identity'));
      expect(result.stdout, isEmpty);
    });

    test('a missing --spec exits 1 with the message', () {
      final result = _run([]);

      expect(result.exitCode, 1);
      expect(result.stderr, contains('Error: --spec is required'));
      expect(result.stdout, isEmpty);
    });

    test('--help exits 0 with usage on stdout', () {
      final result = _run(['--help']);

      expect(result.exitCode, 0, reason: result.stderr.toString());
      expect(result.stdout, contains('--native-package-opt-out'));
    });
  });
}
