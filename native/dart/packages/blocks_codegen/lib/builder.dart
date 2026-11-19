// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_codegen/src/builder.dart' as codegen_builder;
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/language_version.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:build/build.dart';

/// Factory for the build_runner builder.
Builder blocksCodegenBuilder(BuilderOptions options) => _BlocksCodegenBuilder(
  options.config['fail_on_collision'] as bool? ?? false,
  ((options.config['native_package_opt_out'] as List?) ?? const [])
      .cast<String>()
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .toSet(),
);

class _BlocksCodegenBuilder extends Builder {
  /// When true, collisions are a hard error instead of auto-suffixed + warned.
  final bool failOnCollision;

  /// Logical package identities, as keyed in `x-blocks-native-packages`. An
  /// undeclared identity opts nothing out and reports `AWSBLOCKS-NATIVE-006`.
  final Set<String> optedOutPackages;

  _BlocksCodegenBuilder(this.failOnCollision, this.optedOutPackages);

  @override
  final buildExtensions = const {
    '.spec.json': ['.blocks.dart'],
  };

  @override
  Future<void> build(BuildStep buildStep) async {
    final inputId = buildStep.inputId;
    final contents = await buildStep.readAsString(inputId);
    final packageConfig = await buildStep.packageConfig;
    final languageVersion = languageVersionForPackage(
      packageConfig,
      inputId.package,
    );

    final rpcModel = const OpenRpcParser().parse(contents);
    final codegenModel = codegen_builder.CodegenModelBuilder(
      failOnCollision: failOnCollision,
      optedOutPackages: optedOutPackages,
    ).build(rpcModel);
    for (final w in codegenModel.warnings) {
      log.warning(w);
    }
    final output = const DartCodeGenerator().generate(
      codegenModel,
      languageVersion: languageVersion,
    );

    // .spec.json → .blocks.dart (strip both extensions)
    final path = inputId.path;
    final outputPath =
        '${path.substring(0, path.length - '.spec.json'.length)}.blocks.dart';
    final outputId = AssetId(inputId.package, outputPath);
    await buildStep.writeAsString(outputId, output);
  }
}
