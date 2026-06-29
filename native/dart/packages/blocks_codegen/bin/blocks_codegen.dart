import 'dart:io';

import 'package:args/args.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';

void main(List<String> args) {
  final parser = ArgParser()
    ..addOption('spec', abbr: 's', help: 'Path to the OpenRPC spec file')
    ..addOption('output',
        abbr: 'o',
        help: 'Output path for the generated Dart file (stdout if omitted)')
    ..addFlag('fail-on-collision',
        negatable: false,
        help:
            'Treat inline-type name collisions that survive qualification as a '
            'hard error. By default they are auto-disambiguated with a '
            'deterministic suffix and reported as a warning.')
    ..addFlag('help', abbr: 'h', negatable: false, help: 'Show usage');

  final ArgResults results;
  try {
    results = parser.parse(args);
  } on FormatException catch (e) {
    stderr.writeln('Error: ${e.message}');
    stderr.writeln();
    stderr.writeln(
        'Usage: dart run blocks_codegen --spec <path> [--output <path>]');
    stderr.writeln(parser.usage);
    exit(1);
  }

  if (results['help'] as bool) {
    stdout.writeln(
        'Usage: dart run blocks_codegen --spec <path> [--output <path>]');
    stdout.writeln();
    stdout.writeln(parser.usage);
    exit(0);
  }

  final specPath = results['spec'] as String?;
  if (specPath == null) {
    stderr.writeln('Error: --spec is required');
    stderr.writeln();
    stderr.writeln(
        'Usage: dart run blocks_codegen --spec <path> [--output <path>]');
    stderr.writeln(parser.usage);
    exit(1);
  }
  final outputPath = results['output'] as String?;

  final specFile = File(specPath);
  if (!specFile.existsSync()) {
    stderr.writeln('Error: spec file not found: $specPath');
    exit(1);
  }

  final contents = specFile.readAsStringSync();
  final failOnCollision = results['fail-on-collision'] as bool;
  final rpcModel = const OpenRpcParser().parse(contents);
  final String output;
  try {
    final codegenModel =
        CodegenModelBuilder(failOnCollision: failOnCollision).build(rpcModel);
    for (final w in codegenModel.warnings) {
      stderr.writeln('Warning: $w');
    }
    output = const DartCodeGenerator().generate(codegenModel);
  } on NamingConflictException catch (e) {
    stderr.writeln('Error: ${e.message}');
    exit(1);
  }

  if (outputPath != null) {
    final outFile = File(outputPath);
    outFile.parent.createSync(recursive: true);
    outFile.writeAsStringSync(output);
    stdout.writeln('Generated: $outputPath');
  } else {
    stdout.write(output);
  }
}
