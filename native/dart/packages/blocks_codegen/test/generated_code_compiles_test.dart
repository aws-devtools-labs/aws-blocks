// Analyzes generated clients as real Dart, in a scratch package that depends
// on the in-repo blocks_runtime, and runs a JSON round trip through one. The
// golden tests compare text only, so they cannot tell whether an identifier
// the generator produced is one Dart accepts.
@Timeout(Duration(minutes: 5))
library;

import 'dart:convert';
import 'dart:io';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:test/test.dart';

String _generate(String spec) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
);

/// Field and parameter names the spec opens with `_`, including one that
/// matches the generated client's own `_client` field.
final _leadingUnderscoreSpec = jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.put',
      'params': [
        {
          'name': '_client',
          'required': true,
          'schema': {'type': 'string'},
        },
        {
          'name': '_1',
          'required': false,
          'schema': {'type': 'integer'},
        },
      ],
      'result': {
        'name': 'PutResult',
        'schema': {
          'type': 'object',
          'properties': {
            '_x': {'type': 'string'},
            r'$_x': {'type': 'string'},
            '_': {'type': 'string'},
          },
          'required': ['_x'],
        },
      },
    },
  ],
});

/// Decodes and re-encodes every key fixture 29 spells outside an identifier,
/// exiting non-zero when a key does not survive.
const _roundTrip = r'''
import 'dart:convert';
import 'dart:io';

import 'package:scratch/fixture_29.dart';

void check(String what, Object? actual, Object? expected) {
  if (jsonEncode(actual) != jsonEncode(expected)) {
    stderr.writeln('$what: expected ${jsonEncode(expected)}, got ${jsonEncode(actual)}');
    exitCode = 1;
  }
}

void main() {
  final record = <String, dynamic>{
    'run { error("x") } || id': 'id',
    r'$': 'dollar',
    r'${x}': 'interp',
    r'\(y)': 'paren',
    '*/': 'comment',
    'q"uote': 'dq',
    "s'ingle": 'sq',
    'semi;colon': 'semi',
    'back`tick': 'tick',
    'new\nline': 'nl',
    'with space': 3,
    '9lives': true,
    'kind': r'${x}',
  };
  check('record', Sample_Type__x___.fromJson(record).toJson(), record);

  final create = <String, dynamic>{'ty pe': 'cre"ate', 'ti;tle': 't'};
  check('create', NsDo_ActionInput.fromJson(create).toJson(), create);
  final remove = <String, dynamic>{'ty pe': 're`move', r'${id}': 'i'};
  check('remove', NsDo_ActionInput.fromJson(remove).toJson(), remove);

  final result = <String, dynamic>{'ok`': true};
  check('result', DoActionResult.fromJson(result).toJson(), result);
}
''';

Future<ProcessResult> _dart(List<String> args, String dir) =>
    Process.run(Platform.resolvedExecutable, args, workingDirectory: dir);

void _expectSuccess(ProcessResult r, String step) {
  expect(r.exitCode, 0, reason: '$step failed:\n${r.stdout}\n${r.stderr}');
}

void main() {
  final root = Directory.current.path;
  final runtimeDir = Directory('$root/../blocks_runtime');
  final fixtureGolden = File(
    '$root/../../../codegen-fixtures/29-non-identifier-names/dart/client.dart',
  );

  late Directory scratch;

  setUpAll(() async {
    scratch = Directory.systemTemp.createTempSync('blocks_codegen_compile_');
    File('${scratch.path}/pubspec.yaml').writeAsStringSync('''
name: scratch
publish_to: none
environment:
  sdk: ^3.11.0
dependencies:
  blocks_runtime:
    path: ${jsonEncode(runtimeDir.absolute.path)}
''');
    Directory('${scratch.path}/lib').createSync();
    Directory('${scratch.path}/bin').createSync();
    fixtureGolden.copySync('${scratch.path}/lib/fixture_29.dart');
    File(
      '${scratch.path}/lib/leading_underscore.dart',
    ).writeAsStringSync(_generate(_leadingUnderscoreSpec));
    File('${scratch.path}/bin/round_trip.dart').writeAsStringSync(_roundTrip);

    // blocks_runtime's dependencies are already in the pub cache from this
    // package's own `pub get`; resolve online only when they are not.
    var get = await _dart(['pub', 'get', '--offline'], scratch.path);
    if (get.exitCode != 0) get = await _dart(['pub', 'get'], scratch.path);
    _expectSuccess(get, 'pub get');
  });

  tearDownAll(() {
    if (scratch.existsSync()) scratch.deleteSync(recursive: true);
  });

  test('generated clients analyze without errors or warnings', () async {
    _expectSuccess(
      await _dart(['analyze', '--fatal-warnings', 'lib', 'bin'], scratch.path),
      'dart analyze',
    );
  });

  test('fixture 29 keys survive a decode and encode', () async {
    _expectSuccess(
      await _dart(['run', 'bin/round_trip.dart'], scratch.path),
      'round trip',
    );
  });
}
