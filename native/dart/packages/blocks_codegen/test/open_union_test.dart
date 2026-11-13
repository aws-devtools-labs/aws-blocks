import 'dart:io';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// A union with a string discriminator that a response carries is generated
// open: an object whose discriminator names no arm decodes to `XUnknown`,
// which keeps the object and writes it back, instead of throwing. A union only
// parameters reach stays closed.

final _fixtures = Directory('../../../codegen-fixtures');

String _generate(String fixture) {
  final spec = File('${_fixtures.path}/$fixture/spec.json').readAsStringSync();
  return const DartCodeGenerator().generate(
    CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
  );
}

void main() {
  test('a result union falls back to an unknown arm', () {
    final output = _generate('45-open-enums');
    expect(
      output,
      contains(
        '      default: return GetEventResultUnknown(Map.unmodifiable(json));',
      ),
    );
    expect(
      output,
      contains('final class GetEventResultUnknown extends GetEventResult {'),
    );
    expect(
      output,
      contains('  Map<String, dynamic> toJson() => Map.of(json);'),
    );
  });

  test('a union only parameters reach stays closed', () {
    final output = _generate('18-hybrid-arm');
    expect(output, isNot(contains('extends SetAuthStateInput {\n  /// The')));
    expect(output, contains("default: throw ArgumentError('Unknown action:"));
  });

  test('a boolean-discriminated union stays closed', () {
    final output = _generate('24-nullable-discriminated-union');
    expect(output, contains("switch (json['isUpdated'] as bool) {"));
    expect(output, isNot(contains('UpdateAttributesResultUnknown')));
  });

  test('unknown arms decode and round-trip', () async {
    final work = Directory.systemTemp.createTempSync('open_union_test');
    addTearDown(() => work.deleteSync(recursive: true));
    final runtime = Directory('../blocks_runtime').absolute.path;
    File('${work.path}/pubspec.yaml').writeAsStringSync('''
name: open_union_check
publish_to: none
environment:
  sdk: ^3.11.0
dependencies:
  blocks_runtime:
    path: $runtime
''');
    Directory('${work.path}/bin').createSync();
    File(
      '${work.path}/bin/tasks.dart',
    ).writeAsStringSync(_generate('45-open-enums'));
    File('${work.path}/bin/collide.dart').writeAsStringSync(
      const DartCodeGenerator().generate(
        CodegenModelBuilder().build(
          const OpenRpcParser().parse(_collisionSpec),
        ),
      ),
    );
    File('${work.path}/bin/main.dart').writeAsStringSync(_check);

    final get = await Process.run(Platform.resolvedExecutable, [
      'pub',
      'get',
    ], workingDirectory: work.path);
    expect(get.exitCode, 0, reason: '${get.stdout}\n${get.stderr}');
    final run = await Process.run(Platform.resolvedExecutable, [
      'run',
      'bin/main.dart',
    ], workingDirectory: work.path);
    expect(run.exitCode, 0, reason: '${run.stdout}\n${run.stderr}');
    expect(run.stdout, contains('ok'));
  }, timeout: const Timeout(Duration(minutes: 3)));
}

const _check = r'''
import 'dart:convert';

import 'collide.dart' as collide;
import 'tasks.dart';

void check(bool ok, String what) {
  if (!ok) throw StateError('failed: $what');
}

String label(GetEventResult e) => switch (e) {
  MovedGetEventResult() => 'moved',
  FlaggedGetEventResult() => 'flagged',
  UnknownGetEventResult() => 'arm tagged unknown',
  GetEventResultUnknown(:final discriminator) => 'unknown $discriminator',
};

void main() {
  final wire = {
    'kind': 'archived',
    'by': 'someone',
    'at': {'day': 3},
  };
  final event = GetEventResult.fromJson(wire);
  check(event is GetEventResultUnknown, 'unknown arm');
  check(label(event) == 'unknown archived', 'switch');
  check(jsonEncode(event.toJson()) == jsonEncode(wire), 'round trip');
  check(event == GetEventResult.fromJson(jsonDecode(jsonEncode(wire)) as Map<String, dynamic>), 'equality');
  check(GetEventResult.fromJson({'kind': 'moved', 'to': 'done'}) is MovedGetEventResult, 'known arm');
  // An arm tagged `unknown` is a known arm, not the fallback.
  final tagged = GetEventResult.fromJson({'kind': 'unknown', 'note': 'n'});
  check(label(tagged) == 'arm tagged unknown', 'arm tagged unknown');
  // `toJson()` is a copy: changing it leaves the value as it was.
  (event.toJson())['kind'] = 'changed';
  check((event as GetEventResultUnknown).discriminator == 'archived', 'toJson copies');
  var threw = false;
  try {
    event.json['kind'] = 'changed';
  } on UnsupportedError {
    threw = true;
  }
  check(threw, 'decoded json is unmodifiable');
  // `EventUnknown` is a spec type, so the fallback is `EventUnknown$`.
  final odd = collide.Event.fromJson({'kind': 'later'});
  check(odd is collide.EventUnknown$, 'renamed fallback');
  check(odd.toString() == r'EventUnknown$({kind: later})', 'renamed toString');
  print('ok');
}
''';

const _collisionSpec = r'''
{
  "openrpc": "1.3.2",
  "info": { "title": "test", "version": "1.0.0" },
  "methods": [
    {
      "name": "api.get",
      "params": [],
      "result": {
        "name": "GetResult",
        "schema": {
          "type": "object",
          "properties": {
            "event": { "$ref": "#/components/schemas/Event" },
            "other": { "$ref": "#/components/schemas/EventUnknown" }
          },
          "required": ["event", "other"]
        }
      }
    }
  ],
  "components": {
    "schemas": {
      "Event": {
        "oneOf": [
          {
            "type": "object",
            "properties": { "kind": { "type": "string", "enum": ["now"] } },
            "required": ["kind"]
          },
          {
            "type": "object",
            "properties": { "kind": { "type": "string", "enum": ["soon"] } },
            "required": ["kind"]
          }
        ]
      },
      "EventUnknown": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      }
    }
  }
}''';
