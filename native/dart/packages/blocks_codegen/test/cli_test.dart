import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

ProcessResult _run(List<String> args) => Process.runSync(
  Platform.resolvedExecutable,
  ['run', 'bin/blocks_codegen.dart', ...args],
  workingDirectory: Directory.current.path,
);

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
