import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// Names and values from the spec reach the generated library in two forms:
//
// - inside a string literal: a JSON key, a discriminant and its values, an
//   enum's wire values, an operation's wire name, a server URL, and the
//   `Unknown …` error message. A `$` there interpolates, and a `'`, `\` or a
//   newline ends or breaks the literal, so each goes through one escaping
//   helper (`'a\$b'`, `'it\'s'`, `'back\\slash'`, `'\n'`);
// - as an identifier: a field, parameter, method, namespace, server, enum
//   value, or a type (a schema, an inline type named after a field, an
//   operation or a discriminant value, a namespace's `…Api` class). A name
//   with characters Dart identifiers can't hold (`content-type`, `a.b`) is
//   camel-cased across them (`contentType`, `aB`); a leading `_` becomes `$`
//   (`_xApi` → `$xApi`), and a type named after one the library uses
//   (`String`, `Map`, `Blocks`) gets a trailing `$`. Each scope is
//   collision-checked; the wire name is always the original.

Map<String, dynamic> _ref(String name) => {
  r'$ref': '#/components/schemas/$name',
};

Map<String, dynamic> _string() => {'type': 'string'};

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
  String? resultName,
}) => {
  'name': name,
  'params': [
    for (final e in params.entries)
      {'name': e.key, 'required': true, 'schema': e.value},
  ],
  'result': {'name': ?resultName, 'schema': result ?? _string()},
};

String _generate({
  List<Map<String, dynamic>> methods = const [],
  Map<String, dynamic> schemas = const {},
  List<Map<String, String>> servers = const [],
  String title = 't',
}) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(
    const OpenRpcParser().parse(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': title, 'version': '1'},
        if (servers.isNotEmpty) 'servers': servers,
        'methods': methods.isEmpty
            ? [
                for (final s in schemas.keys)
                  _method('api.get${s.length}', result: _ref(s)),
              ]
            : methods,
        'components': {'schemas': schemas},
      }),
    ),
  ),
);

/// The declaration of the class or enum [name] in [output].
String _decl(String output, String name) {
  final start = output.indexOf(RegExp('(class|enum) ${RegExp.escape(name)} '));
  expect(start, isNot(-1), reason: '$name is declared');
  return output.substring(start, output.indexOf('\n}\n', start) + 2);
}

/// Every single-quoted string literal in [output].
Iterable<String> _literals(String output) =>
    RegExp(r"'(?:[^'\\\n]|\\.)*'").allMatches(output).map((m) => m[0]!);

void main() {
  group('a JSON key with `\$`, `\'` or `\\`', () {
    final output = _generate(
      methods: [
        _method(
          'api.save',
          params: {
            r'a$b': _string(),
            "it's": _string(),
            r'back\slash': _string(),
          },
          result: _ref('Doc'),
        ),
      ],
      schemas: {
        'Doc': _object(
          {r'a$b': _string(), "it's": _string(), r'back\slash': _string()},
          required: [r'a$b'],
        ),
        'Open': _object({
          r'a$b': _string(),
          "it's": _string(),
        }, additionalProperties: _string()),
      },
    );

    test('is read from JSON under its escaped key', () {
      final doc = _decl(output, 'Doc');
      expect(doc, contains(r"      a$b: json['a\$b'] as String,"));
      expect(doc, contains(r"      itS: json['it\'s'] as String?,"));
      expect(
        doc,
        contains(r"      backSlash: json['back\\slash'] as String?,"),
      );
    });

    test('is written to JSON under its escaped key', () {
      final doc = _decl(output, 'Doc');
      expect(doc, contains(r"      'a\$b': a$b,"));
      expect(doc, contains(r"      if (itS != null) 'it\'s': itS,"));
      expect(
        doc,
        contains(r"      if (backSlash != null) 'back\\slash': backSlash,"),
      );
    });

    test("is one of an open record's known keys, escaped", () {
      final open = _decl(output, 'Open');
      expect(open, contains(r"    const knownKeys = {'a\$b', 'it\'s'};"));
    });

    test('is sent as a parameter in its slot', () {
      // Params are positional, so the spec name isn't sent (FX48).
      expect(
        output,
        contains(
          r'      a$b,'
          '\n      itS,\n      backSlash,\n',
        ),
      );
      expect(
        output,
        contains(
          r'  Future<Doc> save({required String a$b, required String itS, '
          'required String backSlash}) async {',
        ),
      );
    });

    test('never leaves a quote or interpolation unescaped in a literal', () {
      for (final literal in _literals(output)) {
        expect(
          literal,
          isNot(matches(RegExp(r"(?<!\\)\$(?![a-zA-Z_{])"))),
          reason: literal,
        );
      }
      expect(output, isNot(contains(r"'a$b'")));
      expect(output, isNot(contains("'it's'")));
    });
  });

  group(r"an open union variant with `$` and `'` in its keys", () {
    final output = _generate(
      schemas: {
        'Signal': {
          'oneOf': [
            {
              'type': 'object',
              'properties': {
                r'k$ind': {
                  'type': 'string',
                  'enum': ['a'],
                },
                "it's": _string(),
              },
              'required': [r'k$ind', "it's"],
              'additionalProperties': _string(),
            },
            {
              'type': 'object',
              'properties': {
                r'k$ind': {
                  'type': 'string',
                  'enum': ['b'],
                },
              },
              'required': [r'k$ind'],
            },
          ],
        },
      },
    );

    test('escapes its known keys and the keys its extras skip', () {
      final variant = _decl(output, 'ASignal');
      expect(variant, contains(r"    const knownKeys = {'k\$ind', 'it\'s'};"));
      expect(
        variant,
        contains(r"        if (!const {'k\$ind', 'it\'s'}.contains(e.key)) "),
      );
      expect(variant, contains(r"      itS: json['it\'s'] as String,"));
    });
  });

  group('a discriminated union with `\$` and `\'` in its strings', () {
    final output = _generate(
      schemas: {
        'Event': {
          'oneOf': [
            {
              'type': 'object',
              'properties': {
                r'k$ind': {
                  'type': 'string',
                  'enum': ["it's"],
                },
                'x': _string(),
              },
              'required': [r'k$ind', 'x'],
            },
            {
              'type': 'object',
              'properties': {
                r'k$ind': {
                  'type': 'string',
                  'enum': [r'a$b'],
                },
              },
              'required': [r'k$ind'],
            },
          ],
        },
      },
    );

    test('switches on the escaped discriminant and values', () {
      final base = _decl(output, 'Event');
      expect(base, contains(r"    switch (json['k\$ind'] as String) {"));
      expect(
        base,
        contains(r"      case 'it\'s': return ItSEvent.fromJson(json);"),
      );
      expect(
        base,
        contains(r"      case 'a\$b': return A$bEvent.fromJson(json);"),
      );
      expect(
        base,
        contains(
          r"      default: throw ArgumentError('Unknown k\$ind: ${json['k\$ind']}');",
        ),
      );
    });

    test('writes the escaped discriminant and value', () {
      expect(_decl(output, 'ItSEvent'), contains(r"      'k\$ind': 'it\'s',"));
      expect(_decl(output, r'A$bEvent'), contains(r"      'k\$ind': 'a\$b',"));
    });

    test("prints a variant whose class name holds `\$`", () {
      expect(
        _decl(output, r'A$bEvent'),
        contains(r"  String toString() => 'A\$bEvent()';"),
      );
    });
  });

  group('an enum with `\$`, `\'` or `\\` in a wire value', () {
    final output = _generate(
      schemas: {
        'Mark': {
          'type': 'string',
          'enum': ["it's", r'back\slash', r'a$b', 'new\nline'],
        },
      },
    );

    test('maps each identifier to its escaped wire value', () {
      final mark = _decl(output, 'Mark');
      expect(mark, contains('  itS,\n  backSlash,\n  a\$b,\n  newLine\n;'));
      expect(mark, contains(r"    'it\'s': itS,"));
      expect(mark, contains(r"    'back\\slash': backSlash,"));
      expect(mark, contains(r"    'a\$b': a$b,"));
      expect(mark, contains(r"    'new\nline': newLine,"));
      expect(mark, contains(r"    a$b: 'a\$b',"));
      expect(mark, contains(r"    newLine: 'new\nline',"));
    });
  });

  group('operation, server and title strings', () {
    final output = _generate(
      title: 'My\nAPI',
      methods: [
        _method(r'api.get$x'),
        _method("api.it's"),
        _method('api.get-item'),
      ],
      servers: [
        {'name': 'us-east', 'url': r"https://example.com/$x/it's"},
        {'name': 'dev', 'url': 'http://localhost:3000'},
      ],
    );

    test('calls each operation under its escaped wire name', () {
      expect(output, contains(r'  Future<String> get$x() async {'));
      expect(output, contains(r"_client.call('api.get\$x', "));
      expect(output, contains('  Future<String> itS() async {'));
      expect(output, contains(r"_client.call('api.it\'s', "));
      expect(output, contains('  Future<String> getItem() async {'));
      expect(output, contains("_client.call('api.get-item', "));
    });

    test('escapes a server URL and camel-cases its name', () {
      final servers = _decl(output, 'Servers');
      expect(
        servers,
        contains(
          r"  static const String usEast = 'https://example.com/\$x/it\'s';",
        ),
      );
      expect(
        servers,
        contains("  static const String dev = 'http://localhost:3000';"),
      );
      expect(output, contains('baseUrl ?? Servers.usEast'));
    });

    test('keeps a newline in the title out of the header comment', () {
      expect(output, contains('// Source: My API v1\n'));
      expect(output, isNot(contains('\nAPI v1')));
    });
  });

  group('a constraint pattern', () {
    final output = _generate(
      schemas: {
        'Doc': _object({
          'plain': {'type': 'string', 'pattern': r'^[A-Z]{3}$'},
          'quoted': {'type': 'string', 'pattern': r"^it's\d$"},
        }),
      },
    );

    test('stays a raw literal when it can', () {
      expect(output, contains(r"RegExp(r'^[A-Z]{3}$').hasMatch(plain)"));
    });

    test("is an escaped literal when it holds a `'`", () {
      expect(output, contains(r"RegExp('^it\'s\\d\$').hasMatch(quoted)"));
    });
  });

  group('a name with characters an identifier cannot hold', () {
    final output = _generate(
      methods: [
        _method(
          'api.send',
          params: {'content-type': _string(), 'x.y z': _string()},
          result: _ref('Headers'),
        ),
        _method('a.b.ping'),
        _method('a.b.c.ping'),
      ],
      schemas: {
        'Headers': _object({
          'content-type': _string(),
          'contentType': _string(),
          '1st': _string(),
          'meta-data': _object({'x': _string()}),
        }),
      },
    );

    test('is a camel-cased field; the wire key is the original', () {
      final headers = _decl(output, 'Headers');
      expect(headers, contains('  final String contentType\$;'));
      expect(headers, contains('  final String contentType;'));
      expect(headers, contains(r'  final String $1st;'));
      expect(
        headers,
        contains(r"      contentType$: json['content-type'] as String,"),
      );
      expect(headers, contains(r"      'content-type': contentType$,"));
      expect(headers, contains(r"      'contentType': contentType,"));
      expect(headers, contains(r"      '1st': $1st,"));
    });

    test('names an inline type by its camel-cased field', () {
      final headers = _decl(output, 'Headers');
      expect(headers, contains('  final HeadersMetaData metaData;'));
      expect(output, contains('class HeadersMetaData {'));
      expect(output, isNot(contains('Meta-data')));
    });

    test('is a camel-cased parameter, sent in its slot', () {
      expect(
        output,
        contains(
          '  Future<Headers> send({required String contentType, '
          'required String xYZ}) async {',
        ),
      );
      expect(output, contains('      contentType,\n      xYZ,\n'));
    });

    test('a dotted namespace is a camel-cased field of a valid class', () {
      final blocks = _decl(output, 'Blocks');
      expect(blocks, contains('  late final ABApi aB;'));
      expect(blocks, contains('  late final ABCApi aBC;'));
      expect(blocks, contains('    aB = ABApi(client);'));
      expect(output, contains('class ABApi {'));
      expect(output, contains("_client.call('a.b.ping', "));
      expect(output, contains("_client.call('a.b.c.ping', "));
      expect(output, isNot(contains('A.b')));
    });
  });

  group('namespaces that camel-case to one identifier', () {
    final output = _generate(
      methods: [_method('a.b.ping'), _method('aB.ping'), _method('a-b.ping')],
    );

    test('each get their own field and class', () {
      final blocks = _decl(output, 'Blocks');
      expect(blocks, contains('  late final ABApi aB;'));
      expect(blocks, contains(r'  late final ABApi$ aB$;'));
      expect(blocks, contains(r'  late final ABApi$$ aB$$;'));
      expect(output, contains("_client.call('a.b.ping', "));
      expect(output, contains("_client.call('aB.ping', "));
      expect(output, contains("_client.call('a-b.ping', "));
    });
  });

  group('a type name', () {
    test('of a namespace starting with `_` is a public class', () {
      final output = _generate(methods: [_method('_x.ping'), _method('ping')]);
      final blocks = _decl(output, 'Blocks');
      expect(blocks, contains(r'  late final $xApi $x;'));
      expect(blocks, contains(r'    $x = $xApi(client);'));
      expect(blocks, contains(r'  late final $defaultApi $default;'));
      expect(blocks, contains(r'    $default = $defaultApi(client);'));
      expect(output, contains(r'class $xApi {'));
      expect(output, contains(r'class $defaultApi {'));
      expect(output, isNot(contains('class _')));
    });

    test('named after a core type does not shadow it', () {
      final output = _generate(
        methods: [
          _method(
            'api.save',
            params: {'s': _ref('String'), 'm': _ref('Map')},
            result: _ref('Object'),
          ),
        ],
        schemas: {
          'String': _object({'value': _string(), 'n': _string()}),
          'Map': _object({
            'tags': {'type': 'array', 'items': _ref('String')},
          }),
          'Object': _object({'m': _ref('Map'), 'name': _string()}),
        },
      );
      final string = _decl(output, r'String$');
      expect(string, contains(r'class String$ {'));
      expect(string, contains('  final String value;'));
      expect(
        string,
        contains(r'  factory String$.fromJson(Map<String, dynamic> json) {'),
      );
      expect(
        string,
        contains(r"  String toString() => 'String\$(value: $value, n: $n)';"),
      );
      final map = _decl(output, r'Map$');
      expect(map, contains(r'  final List<String$> tags;'));
      expect(
        map,
        contains(
          r"      tags: (json['tags'] as List<dynamic>).map((e) => "
          r'String$.fromJson(e as Map<String, dynamic>)).toList(),',
        ),
      );
      expect(map, contains(r'          blocksDeepEquals(tags, other.tags);'));
      final object = _decl(output, r'Object$');
      expect(object, contains(r'  final Map$ m;'));
      expect(object, contains('  Map<String, dynamic> toJson() {'));
      expect(object, contains(r'  int get hashCode => Object.hash(m, name);'));
      expect(
        output,
        contains(
          r'  Future<Object$> save({required String$ s, required Map$ m}) async {',
        ),
      );
      expect(
        output,
        contains(
          r'    return Object$.fromJson(result as Map<String, dynamic>);',
        ),
      );
      expect(output, isNot(contains('class String {')));
      expect(output, isNot(contains('class Map {')));
    });

    test('named `Blocks` or `Servers` leaves the facade alone', () {
      final output = _generate(
        schemas: {
          'Blocks': _object({'n': _string()}),
          'Servers': _object({'m': _string()}),
        },
        servers: [
          {'name': 'prod', 'url': 'https://example.com'},
        ],
      );
      expect(output, contains(r'class Blocks$ {'));
      expect(output, contains(r'class Servers$ {'));
      expect(output, contains('class Blocks {'));
      expect(output, contains('class Servers {'));
      expect(output, contains(r'  Future<Blocks$> get6() async {'));
    });

    test('equal to a namespace class keeps its name; the class yields', () {
      final output = _generate(
        methods: [_method('todos.list', result: _ref('TodosApi'))],
        schemas: {
          'TodosApi': _object({'n': _string()}),
        },
      );
      expect(output, contains('class TodosApi {\n  final String n;'));
      expect(output, contains(r'class TodosApi$ {'));
      expect(output, contains(r'  late final TodosApi$ todos;'));
      expect(output, contains('  Future<TodosApi> list() async {'));
    });

    test('starting with `_`, or not an identifier, is escaped everywhere', () {
      final output = _generate(
        methods: [
          _method(
            'api.save',
            params: {'d': _ref('_Doc')},
            result: _ref('my-doc'),
          ),
        ],
        schemas: {
          '_Doc': _object({'n': _string()}),
          'my-doc': _object({'d': _ref('_Doc')}),
        },
      );
      expect(output, contains(r'class $Doc {'));
      expect(output, contains('class myDoc {'));
      expect(output, contains(r'  final $Doc d;'));
      expect(
        output,
        contains(r"      d: $Doc.fromJson(json['d'] as Map<String, dynamic>),"),
      );
      expect(
        output,
        contains(r'  Future<myDoc> save({required $Doc d}) async {'),
      );
      expect(
        output,
        contains("    return myDoc.fromJson(result as Map<String, dynamic>);"),
      );
      expect(output, isNot(contains('_Doc')));
    });

    test('of a union arm named after a non-identifier value is valid', () {
      final output = _generate(
        schemas: {
          'Task': {
            'oneOf': [
              for (final s in ['in-progress', '_done'])
                {
                  'type': 'object',
                  'properties': {
                    'state': {
                      'type': 'string',
                      'enum': [s],
                    },
                  },
                  'required': ['state'],
                },
            ],
          },
        },
      );
      expect(output, contains('class InProgressTask extends Task {'));
      expect(output, contains(r'class $doneTask extends Task {'));
      expect(
        output,
        contains(
          "      case 'in-progress': return InProgressTask.fromJson(json);",
        ),
      );
      expect(
        output,
        contains(r"      case '_done': return $doneTask.fromJson(json);"),
      );
    });

    test('that is already an identifier is unchanged', () {
      final output = _generate(
        methods: [
          _method('api.save', params: {'d': _ref('Doc')}),
        ],
        schemas: {
          'Doc': _object({'n': _string()}),
          'CONFIRM_SIGN_IN': _object({'n': _string(), 'm': _string()}),
        },
      );
      expect(output, contains('class Doc {'));
      expect(output, contains('class CONFIRM_SIGN_IN {'));
      expect(output, contains('  late final ApiApi api;'));
    });
  });

  group('type names that collide once escaped', () {
    final output = _generate(
      methods: [
        _method(
          'api.save',
          params: {
            'a': {'type': 'array', 'items': _ref('my-doc')},
            'b': {'type': 'object', 'additionalProperties': _ref('myDoc')},
            'c': {
              'oneOf': [
                _ref('override'),
                {'type': 'null'},
              ],
            },
          },
          result: {
            'type': 'object',
            'x-blocks-transferable': 'realtime/channel',
            'x-blocks-type-args': [_ref('my-doc')],
          },
        ),
      ],
      schemas: {
        'myDoc': _object({'n': _string()}),
        'my-doc': _object({'m': _string()}),
        'override': _object({'o': _string()}),
      },
    );

    test('get distinct identifiers; the unchanged one keeps its name', () {
      expect(output, contains('class myDoc {\n  final String n;'));
      expect(output, contains('class myDoc\$ {\n  final String m;'));
      expect(output, contains(r'class override$ {'));
      expect(output, contains('  @override\n'));
    });

    test('are renamed in every reference, at any depth', () {
      expect(
        output,
        contains(
          r'required List<myDoc$> a, required Map<String, myDoc> b, '
          r'required override$? c',
        ),
      );
      expect(output, contains(r'      a.map((e) => e.toJson()).toList(),'));
      expect(output, contains(r'RealtimeChannel<myDoc$>'));
      expect(output, contains(r'(json) => myDoc$.fromJson(json)'));
    });
  });

  group('a control character in a spec string', () {
    final output = _generate(
      schemas: {
        'Doc': _object({'a\tb': _string(), 'c\u0001d': _string()}),
      },
    );

    test('is escaped in the literal; the identifier is camel-cased', () {
      final doc = _decl(output, 'Doc');
      expect(doc, contains(r"      aB: json['a\tb'] as String,"));
      expect(doc, contains(r"      'c\u{1}d': cD,"));
      expect(output, isNot(contains('\t')));
      expect(output, isNot(contains('\u0001')));
    });
  });
}
