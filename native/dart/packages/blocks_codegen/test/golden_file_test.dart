// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:dart_style/dart_style.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:test/test.dart';

/// The golden of a fixture whose spec the generator refuses: its message.
const _codegenErrorGolden = 'codegen-error.txt';

void main() {
  final regenerate = Platform.environment['REGENERATE_FIXTURES'] == '1';
  final fixturesDir = Directory(
    '${Directory.current.path}/../../../codegen-fixtures',
  );

  if (!fixturesDir.existsSync()) {
    test('codegen-fixtures directory not found — skipping golden tests', () {});
    return;
  }

  final fixtures =
      fixturesDir
          .listSync()
          .whereType<Directory>()
          .where((d) => File('${d.path}/spec.json').existsSync())
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));

  for (final fixture in fixtures) {
    final name = fixture.uri.pathSegments.where((s) => s.isNotEmpty).last;
    test('fixture: $name', () {
      final specFile = File('${fixture.path}/spec.json');
      final spec = specFile.readAsStringSync();

      final rpcModel = const OpenRpcParser().parse(spec);
      final codegenModel = CodegenModelBuilder().build(rpcModel);

      final goldenDir = Directory('${fixture.path}/dart');
      final errorGolden = File('${goldenDir.path}/$_codegenErrorGolden');

      final String output;
      try {
        output = const DartCodeGenerator().generate(codegenModel);
      } on FormatException catch (e) {
        // A spec the generator refuses (a transferable parameter): the
        // golden is the error.
        if (regenerate) {
          goldenDir.createSync(recursive: true);
          for (final f in goldenDir.listSync().whereType<File>()) {
            f.deleteSync();
          }
          errorGolden.writeAsStringSync('${e.message}\n');
          // ignore: avoid_print
          print('  ✓ regenerated $name: codegen error');
        } else {
          expect(
            errorGolden.existsSync(),
            isTrue,
            reason:
                '$name failed to generate: ${e.message}\n'
                'Run: REGENERATE_FIXTURES=1 dart test test/golden_file_test.dart',
          );
          expect('${e.message}\n', errorGolden.readAsStringSync());
        }
        return;
      }
      expect(
        DartFormatter(languageVersion: Version(3, 11, 0)).format(output),
        output,
        reason: '$name output must already be formatted',
      );

      if (regenerate) {
        goldenDir.createSync(recursive: true);
        for (final f in goldenDir.listSync().whereType<File>()) {
          f.deleteSync();
        }
        File('${goldenDir.path}/client.dart').writeAsStringSync(output);
        // ignore: avoid_print
        print('  ✓ regenerated $name');
      } else {
        if (!goldenDir.existsSync()) {
          fail(
            'No golden files for $name. '
            'Run: REGENERATE_FIXTURES=1 dart test test/golden_file_test.dart',
          );
        }
        expect(
          errorGolden.existsSync(),
          isFalse,
          reason: '$name generates, but its golden is a codegen error',
        );
        final goldenFile = File('${goldenDir.path}/client.dart');
        if (!goldenFile.existsSync()) {
          fail(
            'Golden file missing: client.dart\n'
            'Run: REGENERATE_FIXTURES=1 dart test test/golden_file_test.dart',
          );
        }
        expect(output, goldenFile.readAsStringSync());
      }
    });
  }
}
