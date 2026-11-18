// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:dart_style/dart_style.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:test/test.dart';

void main() {
  final model = CodegenModelBuilder().build(
    const OpenRpcParser().parse(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'formatting', 'version': '1.0.0'},
        'methods': <Object?>[],
      }),
    ),
  );

  test('generate returns deterministic formatted source', () {
    const generator = DartCodeGenerator();
    final output = generator.generate(model);
    final explicitOutput = generator.generate(
      model,
      languageVersion: Version(3, 11, 0),
    );

    expect(output.split('\n').take(2), [
      '// dart format width=80',
      '// GENERATED CODE \u2014 DO NOT MODIFY BY HAND',
    ]);
    expect(output, explicitOutput);
    expect(
      DartFormatter(languageVersion: Version(3, 11, 0)).format(output),
      output,
    );
  });
}
