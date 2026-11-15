import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:test/test.dart';

/// The generated code declares its own names next to user-chosen ones: an
/// operation's `params` array and `result`, the `==` parameter `other`, the
/// `Blocks` constructor's `client` local and its `baseUrl` / `sessionStore`
/// parameters, and closure parameters (`e`, `k`, `v`, `value`, `json`,
/// `payload`). A user name never changes; a generated name that a user name
/// would shadow yields instead (`$result`), and a public generated name
/// (`baseUrl`) is kept and the user's field reached through `this.`.
void main() {
  const gen = DartCodeGenerator();

  /// Every name the generator declares or binds inside a generated body.
  const generatedLocals = [
    'params',
    'result',
    'json',
    'client',
    'value',
    'payload',
    'other',
    'knownKeys',
    'e',
    'e1',
    'k',
    'v',
  ];

  final leaf = RecordType(
    name: 'Leaf',
    fields: const [
      RecordField(name: 'x', type: PrimitiveType('String'), isRequired: true),
    ],
  );

  CodegenModel model({
    List<OperationParam> params = const [],
    ResolvedType result = const PrimitiveType('String'),
    Map<String, ResolvedType> types = const {},
    List<String> namespaces = const ['api'],
  }) => CodegenModel(
    title: 't',
    version: '1',
    namespaces: [
      for (final ns in namespaces)
        Namespace(
          name: ns,
          operations: [
            Operation(
              name: 'run',
              fullName: '$ns.run',
              params: params,
              result: result,
            ),
          ],
        ),
    ],
    types: {'Leaf': leaf, ...types},
  );

  OperationParam param(
    String name, [
    ResolvedType type = const PrimitiveType('String'),
    bool isRequired = true,
  ]) => OperationParam(name: name, type: type, isRequired: isRequired);

  /// The body of `ApiApi.run`.
  String runBody(String output) {
    final start = output.indexOf('  Future<');
    final end = output.indexOf('\n  }\n', start);
    return output.substring(start, end);
  }

  group('operation parameters named after a generated local', () {
    test('a parameter named `result` keeps its name; the local yields', () {
      final body = runBody(gen.generate(model(params: [param('result')])));
      expect(body, contains('Future<String> run({required String result})'));
      expect(body, contains('      result,\n'));
      expect(
        body,
        contains(r"    final $result = await _client.call('api.run', params);"),
      );
      expect(body, contains(r'    return $result as String;'));
      expect(body, isNot(contains('final result =')));
    });

    test('a parameter named `params` keeps its name; the local yields', () {
      final body = runBody(gen.generate(model(params: [param('params')])));
      expect(body, contains('Future<String> run({required String params})'));
      expect(body, contains(r'    final $params = <dynamic>['));
      expect(body, contains('      params,\n'));
      expect(body, contains(r"await _client.call('api.run', $params);"));
      expect(body, contains('    return result as String;'));
    });

    test('`result` and `params` together, optional, and in containers', () {
      final body = runBody(
        gen.generate(
          model(
            params: [
              param('result', ListType(SchemaReference('Leaf'))),
              param('params', MapType(SchemaReference('Leaf')), false),
            ],
            result: ListType(SchemaReference('Leaf')),
          ),
        ),
      );
      expect(
        body,
        contains(
          '      result.map((e) => e.toJson()).toList(),\n'
          '      if (params != null) '
          'params.map((k, v) => MapEntry(k, v.toJson())),\n',
        ),
      );
      expect(
        body,
        contains(
          r"    final $result = await _client.call('api.run', $params);",
        ),
      );
      expect(
        body,
        contains(
          r'    return ($result as List<dynamic>)'
          '.map((e) => Leaf.fromJson(e as Map<String, dynamic>)).toList();',
        ),
      );
    });

    test('a user name equal to the fallback takes the next one', () {
      final body = runBody(
        gen.generate(model(params: [param('result'), param(r'$result')])),
      );
      expect(
        body,
        contains(
          '      result,\n'
          r'      $result,'
          '\n',
        ),
      );
      expect(body, contains(r'    final $result2 = await _client.call('));
      expect(body, contains(r'    return $result2 as String;'));
    });

    test('a void operation declares no `result`, so nothing yields', () {
      final body = runBody(
        gen.generate(
          model(params: [param('result')], result: const PrimitiveType('void')),
        ),
      );
      expect(body, contains("    await _client.call('api.run', params);"));
    });

    test('closure parameter names are never shadowing: each reads its own', () {
      // `e: List<List<Leaf>>` encodes as `e.map((e) => e.map((e1) => …))`:
      // the receiver is read outside each closure, so the user's `e` is the
      // one sent. Likewise `k`, `v`, `value`, `json` and `payload`.
      final body = runBody(
        gen.generate(
          model(
            params: [
              param('e', ListType(ListType(SchemaReference('Leaf')))),
              param('e1', ListType(SchemaReference('Leaf'))),
              param('k', MapType(SchemaReference('Leaf'))),
              param('v', MapType(SchemaReference('Leaf'))),
              param('value', NullableType(SchemaReference('Leaf'))),
              param('json', SchemaReference('Leaf')),
              param('payload', const PrimitiveType('int')),
            ],
          ),
        ),
      );
      expect(
        body,
        contains(
          '      e.map((e) => e.map((e1) => e1.toJson()).toList()).toList(),\n'
          '      e1.map((e) => e.toJson()).toList(),\n'
          '      k.map((k, v) => MapEntry(k, v.toJson())),\n'
          '      v.map((k, v) => MapEntry(k, v.toJson())),\n'
          '      value?.toJson(),\n'
          '      json.toJson(),\n'
          '      payload,\n',
        ),
      );
      expect(body, contains("    final result = await _client.call("));
    });

    test('names that collide with nothing are unchanged', () {
      final body = runBody(
        gen.generate(model(params: [param('id'), param('name')])),
      );
      expect(
        body,
        '  Future<String> run({required String id, required String name}) async {\n'
        '    final params = <dynamic>[\n'
        '      id,\n'
        '      name,\n'
        '    ];\n'
        "    final result = await _client.call('api.run', params);\n"
        '    return result as String;',
      );
    });
  });

  group('model fields named after a generated local', () {
    RecordType everything() => RecordType(
      name: 'Everything',
      fields: [
        for (final n in generatedLocals)
          RecordField(
            name: n,
            type: switch (n) {
              'e' => ListType(SchemaReference('Leaf')),
              'v' => MapType(SchemaReference('Leaf')),
              'value' => NullableType(SchemaReference('Leaf')),
              'other' => const PrimitiveType('int'),
              _ => const PrimitiveType('String'),
            },
            isRequired: true,
          ),
      ],
    );

    String classBody(String output, String name) {
      final start = output.indexOf('class $name ');
      return output.substring(start, output.indexOf('\n}\n', start));
    }

    test('`==` compares every field, including one named `other`', () {
      final cls = classBody(
        gen.generate(model(types: {'Everything': everything()})),
        'Everything',
      );
      expect(cls, contains(r'  bool operator ==(Object $other) =>'));
      expect(cls, contains(r'      identical(this, $other) ||'));
      expect(cls, contains(r'      $other is Everything &&'));
      expect(cls, contains(r'          other == $other.other &&'));
      expect(cls, contains(r'          result == $other.result &&'));
      expect(cls, isNot(contains('other == other.other')));
    });

    test('a union variant field named `other` compares too', () {
      final union = SealedClassType(
        name: 'Shape',
        discriminant: 'kind',
        variants: [
          SealedVariant(
            discriminantValue: 'a',
            className: 'AShape',
            fields: const [
              RecordField(
                name: 'other',
                type: PrimitiveType('int'),
                isRequired: true,
              ),
            ],
          ),
        ],
      );
      final cls = classBody(
        gen.generate(model(types: {'Shape': union})),
        'AShape',
      );
      expect(cls, contains(r'  bool operator ==(Object $other) =>'));
      expect(cls, contains(r'      $other is AShape &&'));
      expect(cls, contains(r'          other == $other.other;'));
    });

    test('fromJson and toJson read the right value for every field', () {
      final cls = classBody(
        gen.generate(model(types: {'Everything': everything()})),
        'Everything',
      );
      // fromJson: a field name is only ever a named-argument label, so the
      // `json` parameter and the closures stay as they are.
      expect(
        cls,
        contains(
          '  factory Everything.fromJson(Map<String, dynamic> json) {\n'
          '    return Everything(\n'
          "      params: json['params'] as String,\n"
          "      result: json['result'] as String,\n"
          "      json: json['json'] as String,\n"
          "      client: json['client'] as String,\n"
          "      value: json['value'] != null ? "
          "Leaf.fromJson(json['value'] as Map<String, dynamic>) : null,\n"
          "      payload: json['payload'] as String,\n"
          "      other: (json['other'] as num).toInt(),\n"
          "      knownKeys: json['knownKeys'] as String,\n"
          "      e: (json['e'] as List<dynamic>).map((e) => "
          'Leaf.fromJson(e as Map<String, dynamic>)).toList(),\n'
          "      e1: json['e1'] as String,\n"
          "      k: json['k'] as String,\n"
          "      v: (json['v'] as Map<String, dynamic>).map((k, v) => "
          'MapEntry(k, Leaf.fromJson(v as Map<String, dynamic>))),\n'
          '    );\n'
          '  }',
        ),
      );
      // toJson: a field is read outside any closure, so it isn't shadowed.
      expect(
        cls,
        contains(
          "      'value': value?.toJson(),\n"
          "      'payload': payload,\n"
          "      'other': other,\n"
          "      'knownKeys': knownKeys,\n"
          "      'e': e.map((e) => e.toJson()).toList(),\n"
          "      'e1': e1,\n"
          "      'k': k,\n"
          "      'v': v.map((k, v) => MapEntry(k, v.toJson())),\n",
        ),
      );
    });

    test('a model without an `other` field keeps `other`', () {
      final cls = classBody(gen.generate(model()), 'Leaf');
      expect(
        cls,
        contains(
          '  bool operator ==(Object other) =>\n'
          '      identical(this, other) ||\n'
          '      other is Leaf &&\n'
          '          x == other.x;',
        ),
      );
    });
  });

  group('namespaces named after a Blocks constructor name', () {
    String facade(String output) =>
        output.substring(output.indexOf('class Blocks {'));

    test('`client`, `baseUrl` and `sessionStore` namespaces are assigned', () {
      final out = facade(
        gen.generate(
          model(namespaces: ['client', 'baseUrl', 'sessionStore', 'api']),
        ),
      );
      expect(out, contains('  late final ClientApi client;'));
      expect(out, contains('  late final BaseUrlApi baseUrl;'));
      expect(out, contains('  late final SessionStoreApi sessionStore;'));
      // The constructor's parameters are public API and keep their names.
      expect(
        out,
        contains(
          '  Blocks({required String baseUrl, SessionStore? sessionStore}) {',
        ),
      );
      expect(
        out,
        contains(
          r'    final $client = BlocksClient(baseUrl: baseUrl, '
          'sessionStore: sessionStore);',
        ),
      );
      expect(out, contains(r'    client = ClientApi($client);'));
      expect(out, contains(r'    this.baseUrl = BaseUrlApi($client);'));
      expect(
        out,
        contains(r'    this.sessionStore = SessionStoreApi($client);'),
      );
      expect(out, contains(r'    api = ApiApi($client);'));
    });

    test('other namespaces are unchanged', () {
      final out = facade(gen.generate(model(namespaces: ['api', 'todos'])));
      expect(
        out,
        contains(
          '    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);\n'
          '    api = ApiApi(client);\n'
          '    todos = TodosApi(client);\n',
        ),
      );
    });
  });
}
