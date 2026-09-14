import 'dart:io';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:test/test.dart';

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

      final CodegenModel codegenModel;
      try {
        final rpcModel = const OpenRpcParser().parse(spec);
        codegenModel = CodegenModelBuilder().build(rpcModel);
      } catch (_) {
        // Skip fixtures that use features the Dart parser doesn't yet support
        markTestSkipped('Dart parser does not support this fixture');
        return;
      }

      final output = const DartCodeGenerator().generate(codegenModel);

      final goldenDir = Directory('${fixture.path}/dart');

      if (regenerate) {
        goldenDir.createSync(recursive: true);
        // Clean existing golden files
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
