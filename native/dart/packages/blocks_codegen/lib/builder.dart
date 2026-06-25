import 'package:build/build.dart';

import 'src/parser.dart';
import 'src/builder.dart' as codegen_builder;
import 'src/generator.dart';

/// Factory for the build_runner builder.
Builder blocksCodegenBuilder(BuilderOptions options) => _BlocksCodegenBuilder(
    options.config['fail_on_collision'] as bool? ?? false);

class _BlocksCodegenBuilder extends Builder {
  /// When true, collisions are a hard error instead of auto-suffixed + warned.
  final bool failOnCollision;

  _BlocksCodegenBuilder(this.failOnCollision);

  @override
  final buildExtensions = const {
    '.spec.json': ['.blocks.dart'],
  };

  @override
  Future<void> build(BuildStep buildStep) async {
    final inputId = buildStep.inputId;
    final contents = await buildStep.readAsString(inputId);

    final rpcModel = const OpenRpcParser().parse(contents);
    final codegenModel = codegen_builder.CodegenModelBuilder(
      failOnCollision: failOnCollision,
    ).build(rpcModel);
    for (final w in codegenModel.warnings) {
      log.warning(w);
    }
    final output = const DartCodeGenerator().generate(codegenModel);

    // .spec.json → .blocks.dart (strip both extensions)
    final path = inputId.path;
    final outputPath =
        path.substring(0, path.length - '.spec.json'.length) + '.blocks.dart';
    final outputId = AssetId(inputId.package, outputPath);
    await buildStep.writeAsString(outputId, output);
  }
}
