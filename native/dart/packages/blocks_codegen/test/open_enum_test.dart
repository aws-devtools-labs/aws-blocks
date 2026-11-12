import 'dart:io';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// A string enum a response carries is generated open: a value the client was
// generated without decodes to `XUnknown` holding the string, instead of
// throwing, and `toJson()` writes it back. An enum only parameters reach stays
// a closed Dart enum.

final _fixtures = Directory('../../../codegen-fixtures');

String _generate(String fixture) {
  final spec = File('${_fixtures.path}/$fixture/spec.json').readAsStringSync();
  return const DartCodeGenerator().generate(
    CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
  );
}

void main() {
  group('open enums', () {
    final output = _generate('43-open-enums');

    test('a result enum is a sealed class with known and unknown cases', () {
      expect(output, contains('sealed class Status {'));
      expect(output, contains('enum StatusKnown implements Status {'));
      expect(output, contains('final class StatusUnknown implements Status {'));
      expect(
        output,
        contains('static const inProgress = StatusKnown.inProgress;'),
      );
      expect(output, contains('static const values = StatusKnown.values;'));
      expect(
        output,
        contains(
          'static Status fromJson(String json) => '
          'StatusKnown._jsonMap[json] ?? StatusUnknown(json);',
        ),
      );
    });

    test(
      'enums in lists, maps, optionals, union arms and channels are open',
      () {
        for (final name in [
          'TaskLabels',
          'TaskPriority',
          'TaskSource',
          'FlaggedGetEventResultSeverity',
          'WatchTasksResultMessageChange',
        ]) {
          expect(output, contains('sealed class $name {'), reason: name);
          expect(output, contains('final class ${name}Unknown'), reason: name);
        }
      },
    );

    test('a spec value named unknown keeps its name', () {
      expect(
        output,
        contains('static const unknown = TaskSourceKnown.unknown;'),
      );
      expect(
        output,
        contains('final class TaskSourceUnknown implements TaskSource {'),
      );
    });

    test('an enum only parameters reach stays closed', () {
      expect(output, contains('enum ApiUpdateTaskSort {'));
      expect(output, isNot(contains('ApiUpdateTaskSortUnknown')));
      expect(
        output,
        contains(
          'static ApiUpdateTaskSort fromJson(String json) => '
          'values.byName(json);',
        ),
      );
    });

    test('an oidc/client provider enum is not a response position', () {
      final oidc = _generate('37-oidc-provider-enum');
      expect(oidc, isNot(contains('Unknown implements')));
    });

    test('the generated classes yield to spec names', () {
      const spec = r'''
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
            "mode": { "$ref": "#/components/schemas/Mode" },
            "other": { "$ref": "#/components/schemas/ModeUnknown" }
          },
          "required": ["mode", "other"]
        }
      }
    }
  ],
  "components": {
    "schemas": {
      "Mode": { "type": "string", "enum": ["a", "ModeKnown"] },
      "ModeUnknown": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      }
    }
  }
}''';
      final out = const DartCodeGenerator().generate(
        CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
      );
      expect(out, contains('class ModeUnknown {'));
      expect(out, contains(r'final class ModeUnknown$ implements Mode {'));
      expect(out, contains(r'?? ModeUnknown$(json);'));
      // A value named like the known-values enum doesn't shadow it.
      expect(
        out,
        contains(r'  static const ModeKnown$ = ModeKnown.ModeKnown$;'),
      );
    });
  });

  // Runs generated code: decodes payloads carrying values the client doesn't
  // know, then encodes them back. Needs the in-repo blocks_runtime, so it
  // builds a scratch package with a path dependency on it.
  test('unknown enum values decode and round-trip', () async {
    final work = Directory.systemTemp.createTempSync('open_enum_test');
    addTearDown(() => work.deleteSync(recursive: true));
    final runtime = Directory('../blocks_runtime').absolute.path;
    File('${work.path}/pubspec.yaml').writeAsStringSync('''
name: open_enum_check
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
    ).writeAsStringSync(_generate('43-open-enums'));
    File(
      '${work.path}/bin/auth.dart',
    ).writeAsStringSync(_generate('18-hybrid-arm'));
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

import 'auth.dart' as auth;
import 'tasks.dart';

void check(bool ok, String what) {
  if (!ok) throw StateError('failed: $what');
}

String label(Status s) => switch (s) {
  Status.todo => 'todo',
  Status.inProgress => 'in progress',
  Status.done => 'done',
  StatusUnknown(:final value) => 'unknown $value',
};

void main() {
  final wire = {
    'id': 't1',
    'status': 'archived',
    'history': ['todo', 'in-progress', 'blocked'],
    'labels': {'a': 'red', 'b': 'purple'},
    'priority': 'urgent',
    'source': 'unknown',
  };
  final task = Task.fromJson(wire);
  check(task.status == const StatusUnknown('archived'), 'status');
  check(label(task.status) == 'unknown archived', 'switch');
  check(task.history[1] == Status.inProgress, 'known in list');
  check(task.history[2] is StatusUnknown, 'unknown in list');
  check(task.labels['b'] is TaskLabelsUnknown, 'unknown in map');
  check(task.priority is TaskPriorityUnknown, 'optional');
  check(task.source == TaskSource.unknown, 'spec value named unknown');
  check(jsonEncode(task.toJson()) == jsonEncode(wire), 'round trip');
  check(Status.values.length == 3, 'values');

  final event = GetEventResult.fromJson({'kind': 'flagged', 'severity': 'critical'});
  check(
    event is FlaggedGetEventResult &&
        event.severity == const FlaggedGetEventResultSeverityUnknown('critical'),
    'union arm',
  );

  final state = auth.AuthState.fromJson({
    'state': 'enrollingTotp',
    'actions': [
      {
        'name': 'verifyTotp',
        'label': 'Verify',
        'fields': [
          {'name': 'otp', 'label': 'Code', 'type': 'otp', 'required': true},
        ],
        'capability': 'webauthn-future',
      },
    ],
  });
  check(state.state == const auth.AuthStateStateUnknown('enrollingTotp'), 'auth state');
  check(state.actions[0].fields[0].type is auth.AuthFieldTypeUnknown, 'field type');
  check(state.actions[0].capability is auth.AuthActionCapabilityUnknown, 'capability');
  check(state.toJson()['state'] == 'enrollingTotp', 'auth round trip');
  print('ok');
}
''';
