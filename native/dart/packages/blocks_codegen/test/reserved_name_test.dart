import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// A name from the spec becomes a Dart identifier: a field, a named parameter,
// a method, a `Blocks` field, an enum value or a `Servers` constant. Some
// names can't be used as they are:
//
// - a leading `_` makes a name library-private (a field nobody outside the
//   generated library can read), and a named parameter can't start with `_`;
// - a member the generated class declares itself (`toJson`, `fromJson`, the
//   map `additionalProperties`) or inherits (`hashCode`, `toString`,
//   `runtimeType`, `noSuchMethod`), or an enum's built-ins (`values`, `index`,
//   `name`), is a duplicate or an invalid override;
// - a type the generated code names (`int`, `String`, `Map`, a model's own
//   name), or the `@override` annotation, is shadowed by a member or a
//   parameter of that name, which breaks every later use in that scope.
//
// Such a name is escaped, as a keyword already was (`class$`): a reserved or
// colliding name gets a trailing `$` (`toJson$`, `values$`, `int$`), and a
// leading `_` becomes `$` (`_id` → `$id`). The wire name is always the original
// key, and every other name is unchanged.

Map<String, dynamic> _ref(String name) => {
  r'$ref': '#/components/schemas/$name',
};

Map<String, dynamic> _string() => {'type': 'string'};

Map<String, dynamic> _int() => {'type': 'integer'};

Map<String, dynamic> _object(
  Map<String, dynamic> properties, {
  List<String>? required,
  Map<String, dynamic>? additionalProperties,
}) => {
  'type': 'object',
  'properties': properties,
  'required': required ?? properties.keys.toList(),
  'additionalProperties': ?additionalProperties,
};

Map<String, dynamic> _method(
  String name, {
  Map<String, Map<String, dynamic>> params = const {},
  Map<String, dynamic>? result,
}) => {
  'name': name,
  'params': [
    for (final e in params.entries)
      {'name': e.key, 'required': true, 'schema': e.value},
  ],
  'result': {
    'name': '${name.split('.').last[0].toUpperCase()}Result',
    'schema': result ?? _string(),
  },
};

String _generate({
  List<Map<String, dynamic>> methods = const [],
  Map<String, dynamic> schemas = const {},
  List<Map<String, String>> servers = const [],
}) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(
    const OpenRpcParser().parse(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 't', 'version': '1'},
        if (servers.isNotEmpty) 'servers': servers,
        'methods': methods.isEmpty
            ? [
                for (final s in schemas.keys)
                  _method('api.get$s', result: _ref(s)),
              ]
            : methods,
        'components': {'schemas': schemas},
      }),
    ),
  ),
);

/// The declaration of the class or enum [name] in [output].
String _decl(String output, String name) {
  final start = output.indexOf(RegExp('(class|enum) $name '));
  expect(start, isNot(-1), reason: '$name is declared');
  return output.substring(start, output.indexOf('\n}\n', start) + 2);
}

void main() {
  group('a name starting with `_`', () {
    final output = _generate(
      methods: [
        _method(
          'api.save',
          params: {'_id': _string(), '__v': _int(), 'name': _string()},
          result: _ref('Doc'),
        ),
        _method('api._hidden'),
        _method('_internal.ping'),
        _method('ping'),
      ],
      schemas: {
        'Doc': _object(
          {
            '_id': {'type': 'string', 'minLength': 1},
            '__v': _int(),
            'name': _string(),
          },
          required: ['_id', 'name'],
        ),
        'Level': {
          'type': 'string',
          'enum': ['_hidden', '1st', 'ok'],
        },
      },
    );

    test('is a public field: the `_` becomes `\$`', () {
      final doc = _decl(output, 'Doc');
      expect(doc, contains(r'  final String $id;'));
      expect(doc, contains(r'  final int? $$v;'));
      expect(doc, contains(r'    required this.$id,'));
      expect(doc, contains(r'    this.$$v,'));
      expect(doc, isNot(contains('this._')));
    });

    test('keeps its wire name', () {
      final doc = _decl(output, 'Doc');
      expect(doc, contains(r"      $id: json['_id'] as String,"));
      expect(doc, contains(r"      $$v: (json['__v'] as num?)?.toInt(),"));
      expect(doc, contains(r"      '_id': $id,"));
      expect(doc, contains(r"      if ($$v != null) '__v': $$v,"));
    });

    test('is checked, compared, hashed and printed by its identifier', () {
      final doc = _decl(output, 'Doc');
      expect(
        doc,
        contains(
          r"    if (!($id.length >= 1)) throw ArgumentError('\$id must be at "
          "least 1 characters');",
        ),
      );
      expect(doc, contains(r'          $id == other.$id &&'));
      expect(doc, contains(r'Object.hash($id, $$v, name)'));
      expect(doc, contains(r"'Doc(\$id: ${$id}, \$\$v: ${$$v}, name: $name)'"));
    });

    test('is a named parameter, sent in its slot', () {
      expect(
        output,
        contains(
          r'  Future<Doc> save({required String $id, required int $$v, '
          'required String name}) async {',
        ),
      );
      // Params are positional, so the wire name isn't sent (FX48).
      expect(
        output,
        contains(
          r'      $id,'
          '\n'
          r'      $$v,'
          '\n      name,\n',
        ),
      );
    });

    test('is a public method that calls the original operation', () {
      expect(output, contains(r'  Future<String> $hidden() async {'));
      expect(output, contains("_client.call('api._hidden', "));
    });

    test('is a public `Blocks` field, including the dotless `_default`', () {
      final blocks = _decl(output, 'Blocks');
      expect(blocks, contains(r'  late final $internalApi $internal;'));
      expect(blocks, contains(r'    $internal = $internalApi(client);'));
      expect(blocks, contains(r'  late final $defaultApi $default;'));
      expect(blocks, contains(r'    $default = $defaultApi(client);'));
    });

    test('is a public enum value, including a sanitized `1st`', () {
      final level = _decl(output, 'Level');
      expect(level, contains('  \$hidden,\n  \$1st,\n  ok\n;'));
      expect(level, contains(r"    '_hidden': $hidden,"));
      expect(level, contains(r"    '1st': $1st,"));
      expect(level, contains(r"    $hidden: '_hidden',"));
      expect(level, contains('  String toJson() => _toJsonMap[this]!;'));
    });
  });

  group('a field named after a member of its class', () {
    const members = [
      'toJson',
      'fromJson',
      'hashCode',
      'toString',
      'runtimeType',
      'noSuchMethod',
    ];
    final output = _generate(
      schemas: {
        'Doc': _object({for (final m in members) m: _string()}),
        'Open': _object({
          'additionalProperties': _string(),
          'id': _string(),
        }, additionalProperties: _int()),
        'Closed': _object({'additionalProperties': _string()}),
        'Shape': {
          'oneOf': [
            _object({
              'kind': {
                'type': 'string',
                'enum': ['circle'],
              },
              'toJson': _string(),
              'hashCode': _int(),
            }),
            _object(
              {
                'kind': {
                  'type': 'string',
                  'enum': ['square'],
                },
                'toString': _string(),
              },
              required: ['kind'],
            ),
          ],
          'discriminator': {'propertyName': 'kind'},
        },
      },
    );

    test('is escaped with a trailing `\$` and keeps its wire name', () {
      final doc = _decl(output, 'Doc');
      for (final m in members) {
        expect(doc, contains('  final String $m\$;'));
        expect(doc, contains('    required this.$m\$,'));
        expect(doc, contains("      $m\$: json['$m'] as String,"));
        expect(doc, contains("      '$m': $m\$,"));
      }
      // The generated members themselves are untouched.
      expect(doc, contains('  factory Doc.fromJson(Map<String, dynamic> json'));
      expect(doc, contains('  Map<String, dynamic> toJson() {'));
      expect(doc, contains('  int get hashCode => Object.hash('));
      expect(doc, contains('  String toString() => '));
      expect(doc, contains(r"'Doc(toJson\$: ${toJson$}, "));
    });

    test('`additionalProperties` is escaped only in an open record', () {
      final open = _decl(output, 'Open');
      expect(open, contains(r'  final String additionalProperties$;'));
      expect(open, contains('  final Map<String, int> additionalProperties;'));
      expect(open, contains(r'    required this.additionalProperties$,'));
      expect(open, contains('    this.additionalProperties = const {},'));
      expect(
        open,
        contains("    const knownKeys = {'additionalProperties', 'id'};"),
      );
      expect(
        open,
        contains(
          r"      additionalProperties$: json['additionalProperties'] as String,",
        ),
      );
      expect(
        open,
        contains(r"      'additionalProperties': additionalProperties$,"),
      );
      // The map's own `additionalProperties` key is the typed field's, so an
      // extra of that name isn't sent.
      expect(
        open,
        contains(
          '      for (final e in additionalProperties.entries)\n'
          "        if (!const {'additionalProperties', 'id'}.contains(e.key)) "
          'e.key: e.value,',
        ),
      );
      expect(
        open,
        contains(
          r'Object.hash(additionalProperties$, id, '
          'blocksDeepHash(additionalProperties))',
        ),
      );

      final closed = _decl(output, 'Closed');
      expect(closed, contains('  final String additionalProperties;'));
      expect(closed, isNot(contains(r'additionalProperties$')));
    });

    test('in a union variant is escaped too', () {
      final circle = _decl(output, 'CircleShape');
      expect(circle, contains(r'  final String toJson$;'));
      expect(circle, contains(r'  final int hashCode$;'));
      expect(circle, contains(r"      toJson$: json['toJson'] as String,"));
      expect(circle, contains(r"      'toJson': toJson$,"));
      expect(circle, contains("      'kind': 'circle',"));
      final square = _decl(output, 'SquareShape');
      expect(square, contains(r'  final String? toString$;'));
      expect(square, contains(r"      if (toString$ != null) 'toString': "));
    });
  });

  group('an enum value named after an enum built-in', () {
    test('`values`, `index` and `name` are escaped; `ok` is not', () {
      final level = _decl(
        _generate(
          schemas: {
            'Level': {
              'type': 'string',
              'enum': ['values', 'index', 'name', 'toJson', 'hashCode', 'ok'],
            },
          },
        ),
        'Level',
      );
      expect(
        level,
        contains(
          '  values\$,\n  index\$,\n  name\$,\n  toJson\$,\n  hashCode\$,\n'
          '  ok\n;',
        ),
      );
      expect(level, contains(r"    'values': values$,"));
      expect(level, contains(r"    'name': name$,"));
      expect(level, contains(r"    index$: 'index',"));
      expect(level, contains('    ok: \'ok\','));
      // `values.byName` and `name` would now name the user's values; the
      // escaped values go through the maps instead.
      expect(level, contains('  String toJson() => _toJsonMap[this]!;'));
      expect(
        level,
        contains('  static Level fromJson(String json) => _jsonMap[json]!;'),
      );
    });

    test('a keyword value is escaped too (it used to break the enum)', () {
      final level = _decl(
        _generate(
          schemas: {
            'Level': {
              'type': 'string',
              'enum': ['class', 'low'],
            },
          },
        ),
        'Level',
      );
      expect(level, contains('  class\$,\n  low\n;'));
      expect(level, contains(r"    'class': class$,"));
    });

    test('two values that sanitize alike get distinct identifiers', () {
      final level = _decl(
        _generate(
          schemas: {
            'Level': {
              'type': 'string',
              'enum': ['a-b', 'aB'],
            },
          },
        ),
        'Level',
      );
      expect(level, contains('  aB\$,\n  aB\n;'));
      expect(level, contains(r"    'a-b': aB$,"));
      expect(level, contains("    'aB': aB,"));
    });
  });

  group('a name that shadows a type the generated code uses', () {
    final output = _generate(
      methods: [
        _method(
          'api.save',
          params: {
            'String': _string(),
            'int': _int(),
            'Map': {'type': 'object', 'additionalProperties': _string()},
            'Doc': _ref('Doc'),
          },
          result: _ref('Doc'),
        ),
        _method('api.Doc', result: _ref('Doc')),
      ],
      schemas: {
        'Doc': _object({
          'int': _int(),
          'String': _string(),
          'bool': {'type': 'boolean'},
          'List': {'type': 'array', 'items': _string()},
          'Map': {'type': 'object', 'additionalProperties': _int()},
          'Object': _string(),
          'override': _string(),
          'identical': _string(),
          'Doc': _string(),
          'Level': _ref('Level'),
        }),
        'Level': {
          'type': 'string',
          'enum': ['String', 'Level', 'low'],
        },
      },
    );

    test('as a field is escaped, and the type stays reachable', () {
      final doc = _decl(output, 'Doc');
      expect(doc, contains(r'  final int int$;'));
      expect(doc, contains(r'  final String String$;'));
      expect(doc, contains(r'  final bool bool$;'));
      expect(doc, contains(r'  final List<String> List$;'));
      expect(doc, contains(r'  final Map<String, int> Map$;'));
      expect(doc, contains(r'  final String Object$;'));
      expect(doc, contains(r'  final String override$;'));
      expect(doc, contains(r'  final String identical$;'));
      expect(doc, contains(r'  final String Doc$;'));
      expect(doc, contains(r'  final Level Level$;'));
      expect(doc, contains(r"      int$: (json['int'] as num).toInt(),"));
      expect(doc, contains(r"      Level$: Level.fromJson(json['Level'] "));
      expect(doc, contains(r"      'Level': Level$.toJson(),"));
    });

    test('as a parameter is escaped and sent in its slot', () {
      expect(
        output,
        contains(
          r'  Future<Doc> save({required String String$, required int int$, '
          r'required Map<String, String> Map$, required Doc Doc$}) async {',
        ),
      );
      expect(
        output,
        contains(
          r'      String$,'
          '\n'
          r'      int$,'
          '\n'
          r'      Map$,'
          '\n'
          r'      Doc$.toJson(),'
          '\n',
        ),
      );
    });

    test('as a method is escaped', () {
      expect(output, contains(r'  Future<Doc> Doc$() async {'));
      expect(output, contains("_client.call('api.Doc', "));
    });

    test('as an enum value is escaped', () {
      final level = _decl(output, 'Level');
      expect(level, contains('  String\$,\n  Level\$,\n  low\n;'));
      expect(level, contains(r"    'String': String$,"));
    });
  });

  group('operations, namespaces and servers', () {
    final output = _generate(
      methods: [
        _method('api.toString'),
        _method('api.hashCode'),
        _method('api.name'),
        _method('runtimeType.ping'),
        _method('toString.ping'),
      ],
      servers: [
        {'name': 'toString', 'url': 'https://a.example'},
        {'name': '_local', 'url': 'http://localhost'},
      ],
    );

    test('an operation named after an `Object` member is escaped', () {
      expect(output, contains(r'  Future<String> toString$() async {'));
      expect(output, contains("_client.call('api.toString', "));
      expect(output, contains(r'  Future<String> hashCode$() async {'));
      expect(output, contains('  Future<String> name() async {'));
    });

    test('a namespace named after an `Object` member is escaped', () {
      final blocks = _decl(output, 'Blocks');
      expect(blocks, contains(r'  late final RuntimeTypeApi runtimeType$;'));
      expect(blocks, contains(r'  late final ToStringApi toString$;'));
      expect(blocks, contains(r'    runtimeType$ = RuntimeTypeApi(client);'));
      expect(blocks, contains('  late final ApiApi api;'));
    });

    test('a server name is escaped, and the default reads it', () {
      final servers = _decl(output, 'Servers');
      expect(
        servers,
        contains(r"  static const String toString$ = 'https://a.example';"),
      );
      expect(
        servers,
        contains(r"  static const String $local = 'http://localhost';"),
      );
      expect(output, contains(r'baseUrl ?? Servers.toString$'));
    });
  });

  group('names that collide with nothing are unchanged', () {
    test('a parameter may be named like a model member', () {
      final output = _generate(
        methods: [
          _method(
            'api.run',
            params: {'toJson': _string(), 'hashCode': _string()},
          ),
        ],
      );
      expect(
        output,
        contains(
          '  Future<String> run({required String toJson, '
          'required String hashCode}) async {',
        ),
      );
    });

    test('a record field may be named like an enum built-in', () {
      final doc = _decl(
        _generate(
          schemas: {
            'Doc': _object({
              'values': _string(),
              'index': _int(),
              'name': _string(),
              'id_': _string(),
              'a_b': _string(),
            }),
          },
        ),
        'Doc',
      );
      expect(doc, contains('  final String values;'));
      expect(doc, contains('  final int index;'));
      expect(doc, contains('  final String name;'));
      expect(doc, contains('  final String id_;'));
      expect(doc, contains('  final String a_b;'));
      expect(doc, isNot(contains(r'$;')));
    });

    test('a keyword is still escaped as before', () {
      final doc = _decl(
        _generate(
          schemas: {
            'Doc': _object({'class': _string(), 'type': _string()}),
          },
        ),
        'Doc',
      );
      expect(doc, contains(r'  final String class$;'));
      expect(doc, contains('  final String type;'));
    });
  });

  group('with the generated locals (R62)', () {
    test('`_result` is `\$result`, and the local yields past both', () {
      final output = _generate(
        methods: [
          _method('api.run', params: {'result': _string(), '_result': _int()}),
        ],
      );
      expect(
        output,
        contains(
          r'  Future<String> run({required String result, '
          r'required int $result}) async {',
        ),
      );
      expect(
        output,
        contains(
          '      result,\n'
          r'      $result,'
          '\n',
        ),
      );
      expect(output, contains(r'    final $result2 = await _client.call('));
      expect(output, contains(r'    return $result2 as String;'));
    });

    test('`_result` alone leaves the local `result`', () {
      final output = _generate(
        methods: [
          _method('api.run', params: {'_result': _int()}),
        ],
      );
      expect(output, contains(r'run({required int $result})'));
      expect(output, contains('    final result = await _client.call('));
    });

    test('a field `_other` does not make `==` rename `other`', () {
      final doc = _decl(
        _generate(
          schemas: {
            'Doc': _object({'_other': _string(), 'other': _string()}),
          },
        ),
        'Doc',
      );
      expect(doc, contains(r'  final String $other;'));
      expect(doc, contains(r'  bool operator ==(Object $other2) =>'));
      expect(doc, contains(r'          $other == $other2.$other &&'));
      expect(doc, contains(r'          other == $other2.other;'));
    });
  });
}
