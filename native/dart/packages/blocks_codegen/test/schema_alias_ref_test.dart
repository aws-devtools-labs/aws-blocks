import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// A component schema that isn't a model, an enum or a discriminated union —
// a string, an array, a map, a nullable, or a union the generator types as
// `dynamic` (one discriminated by `const`, as in fixture 10) — has no Dart
// declaration. A `$ref` to one used to emit the schema's name anyway
// (`final Shape one`, `Shape.fromJson(…)`), so the client didn't analyze. A
// `$ref` to such a schema now stands for the type the schema resolves to.

Map<String, dynamic> _ref(String name) => {
  r'$ref': '#/components/schemas/$name',
};

Map<String, dynamic> _arm(String kind, Map<String, dynamic> discriminant) => {
  'type': 'object',
  'properties': {'kind': discriminant},
  'required': ['kind'],
};

final _spec = jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 't', 'version': '1'},
  'methods': [
    {
      'name': 'api.fetch',
      'params': [
        {'name': 'id', 'required': true, 'schema': _ref('UserId')},
        {'name': 'shape', 'required': true, 'schema': _ref('Shape')},
        {'name': 'tags', 'required': false, 'schema': _ref('Tags')},
      ],
      'result': {'name': 'FetchResult', 'schema': _ref('Holder')},
    },
    {
      'name': 'api.shapes',
      'params': <Object>[],
      'result': {'name': 'ShapesResult', 'schema': _ref('Notes')},
    },
  ],
  'components': {
    'schemas': {
      'Note': {
        'type': 'object',
        'properties': {
          'text': {'type': 'string'},
        },
        'required': ['text'],
      },
      'UserId': {'type': 'string', 'minLength': 1},
      'Count': {'type': 'integer'},
      'Tags': {
        'type': 'array',
        'items': {'type': 'string'},
      },
      'Notes': {'type': 'array', 'items': _ref('Note')},
      'NotesById': {'type': 'object', 'additionalProperties': _ref('Note')},
      'MaybeNote': {
        'oneOf': [
          _ref('Note'),
          {'type': 'null'},
        ],
      },
      'IdAlias': _ref('UserId'),
      // Discriminated by `const`: the Dart generator types it `dynamic`.
      'Shape': {
        'oneOf': [
          _arm('a', {'const': 'a'}),
          _arm('b', {'const': 'b'}),
        ],
      },
      // Discriminated by a one-value enum: a sealed class.
      'Kind': {
        'oneOf': [
          _arm('a', {
            'type': 'string',
            'enum': ['a'],
          }),
          _arm('b', {
            'type': 'string',
            'enum': ['b'],
          }),
        ],
      },
      'Loop': {'type': 'array', 'items': _ref('Loop')},
      'Holder': {
        'type': 'object',
        'properties': {
          'id': _ref('UserId'),
          'count': _ref('Count'),
          'maybeCount': _ref('Count'),
          'tags': _ref('Tags'),
          'notes': _ref('Notes'),
          'byId': _ref('NotesById'),
          'maybe': _ref('MaybeNote'),
          'alias': _ref('IdAlias'),
          'one': _ref('Shape'),
          'many': {'type': 'array', 'items': _ref('Shape')},
          'kind': _ref('Kind'),
          'loop': _ref('Loop'),
        },
        'required': [
          'id',
          'count',
          'tags',
          'notes',
          'byId',
          'maybe',
          'alias',
          'one',
          'many',
          'kind',
          'loop',
        ],
      },
    },
  },
});

void main() {
  final output = const DartCodeGenerator().generate(
    CodegenModelBuilder().build(const OpenRpcParser().parse(_spec)),
  );

  String holder() {
    final start = output.indexOf('class Holder {');
    return output.substring(start, output.indexOf('\n}\n', start));
  }

  test('a field typed by a `\$ref` to a non-model schema uses its type', () {
    expect(
      holder(),
      contains(
        '  final String id;\n'
        '  final int count;\n'
        '  final int? maybeCount;\n'
        '  final List<String> tags;\n'
        '  final List<Note> notes;\n'
        '  final Map<String, Note> byId;\n'
        '  final Note? maybe;\n'
        '  final String alias;\n'
        '  final dynamic one;\n'
        '  final List<dynamic> many;\n'
        '  final Kind kind;\n'
        '  final dynamic loop;\n',
      ),
    );
  });

  test('fromJson decodes through the referenced schema\'s type', () {
    expect(
      holder(),
      contains(
        "      id: json['id'] as String,\n"
        "      count: (json['count'] as num).toInt(),\n"
        "      maybeCount: (json['maybeCount'] as num?)?.toInt(),\n"
        "      tags: (json['tags'] as List<dynamic>).cast<String>(),\n"
        "      notes: (json['notes'] as List<dynamic>).map((e) => Note.fromJson(e as Map<String, dynamic>)).toList(),\n"
        "      byId: (json['byId'] as Map<String, dynamic>).map((k, v) => MapEntry(k, Note.fromJson(v as Map<String, dynamic>))),\n"
        "      maybe: json['maybe'] != null ? Note.fromJson(json['maybe'] as Map<String, dynamic>) : null,\n"
        "      alias: json['alias'] as String,\n"
        "      one: json['one'] as dynamic,\n"
        "      many: (json['many'] as List<dynamic>).cast<dynamic>(),\n"
        "      kind: Kind.fromJson(json['kind'] as Map<String, dynamic>),\n"
        "      loop: json['loop'] as dynamic,\n",
      ),
    );
  });

  test('toJson encodes through the referenced schema\'s type', () {
    expect(
      holder(),
      contains(
        "      'id': id,\n"
        "      'count': count,\n"
        "      if (maybeCount != null) 'maybeCount': maybeCount,\n"
        "      'tags': tags,\n"
        "      'notes': notes.map((e) => e.toJson()).toList(),\n"
        "      'byId': byId.map((k, v) => MapEntry(k, v.toJson())),\n"
        "      'maybe': maybe?.toJson(),\n"
        "      'alias': alias,\n"
        "      'one': one,\n"
        "      'many': many,\n"
        "      'kind': kind.toJson(),\n"
        "      'loop': loop,\n",
      ),
    );
  });

  test('`==` compares a `\$ref` list or map deeply', () {
    expect(
      holder(),
      contains('          blocksDeepEquals(notes, other.notes) &&'),
    );
    expect(
      holder(),
      contains('          blocksDeepEquals(byId, other.byId) &&'),
    );
  });

  test('operation parameters and results use the referenced type', () {
    expect(
      output,
      contains(
        '  Future<Holder> fetch({required String id, required dynamic shape, List<String>? tags}) async {',
      ),
    );
    expect(output, contains('  Future<List<Note>> shapes() async {'));
    expect(
      output,
      contains(
        '    return (result as List<dynamic>).map((e) => Note.fromJson(e as Map<String, dynamic>)).toList();',
      ),
    );
  });

  test('no declaration is emitted for, or named after, a non-model schema', () {
    for (final name in [
      'UserId',
      'Count',
      'Tags',
      'Notes',
      'NotesById',
      'MaybeNote',
      'IdAlias',
      'Shape',
      'Loop',
    ]) {
      expect(output, isNot(contains(RegExp('\\b$name\\b'))), reason: name);
    }
  });

  test('a `\$ref` to a model, an enum or a sealed class is unchanged', () {
    expect(output, contains('sealed class Kind {'));
    expect(output, contains('class Note {'));
  });
}
