import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:test/test.dart';

/// JSON-RPC params are positional on an AWS Blocks server: `parseRpcRequest`
/// (`packages/core`) passes an array as the method's argument list, and reads
/// an object's values in order (`Object.values()`), so a by-name key that is
/// left out moves every later value up a slot. A generated client used to
/// send a by-name map that skipped unset optionals, so
/// `echoArgs(first: 'a', last: 'c')` reached the server as
/// `echoArgs('a', 'c')`: `middle = 'c'`.
///
/// A call now sends its arguments as the TypeScript client does
/// (`encodeRpcRequest`), and as Kotlin does since FX45 (R81): an array in the
/// spec's parameter order, `null` in the slot of an unset optional that comes
/// before a set or required argument, and trailing unset optionals left off.
void main() {
  const gen = DartCodeGenerator();

  final leaf = RecordType(
    name: 'Leaf',
    fields: const [
      RecordField(name: 'x', type: PrimitiveType('String'), isRequired: true),
    ],
  );

  OperationParam param(
    String name, [
    ResolvedType type = const PrimitiveType('String'),
  ]) => OperationParam(name: name, type: type, isRequired: true);

  OperationParam optional(
    String name, [
    ResolvedType type = const PrimitiveType('String'),
  ]) => OperationParam(name: name, type: type, isRequired: false);

  String generate(Map<String, List<OperationParam>> operations) => gen.generate(
    CodegenModel(
      title: 't',
      version: '1',
      namespaces: [
        Namespace(
          name: 'api',
          operations: [
            for (final MapEntry(key: name, value: params) in operations.entries)
              Operation(
                name: name,
                fullName: 'api.$name',
                params: params,
                result: const PrimitiveType('String'),
              ),
          ],
        ),
      ],
      types: {'Leaf': leaf},
    ),
  );

  /// The body of the generated method [name].
  String body(String output, String name) {
    final start = output.indexOf('  Future<String> $name(');
    expect(start, isNot(-1), reason: 'missing `$name`');
    return output.substring(start, output.indexOf('\n  }\n', start));
  }

  group('an operation sends its arguments positionally', () {
    test('a left-out middle optional keeps the later one in its slot', () {
      final out = body(
        generate({
          'echoArgs': [param('first'), optional('middle'), optional('last')],
        }),
        'echoArgs',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      first,\n'
          '      if (middle != null || last != null) middle,\n'
          '      if (last != null) last,\n'
          '    ];\n'
          "    final result = await _client.call('api.echoArgs', params);\n",
        ),
      );
    });

    test('no parameter names are sent', () {
      final out = body(
        generate({
          'echoArgs': [param('first'), optional('middle'), optional('last')],
        }),
        'echoArgs',
      );
      expect(out, isNot(contains('<String, dynamic>{')));
      expect(out, isNot(contains("'first'")));
      expect(out, isNot(contains("'middle'")));
      expect(out, isNot(contains("'last'")));
    });

    test('required parameters are sent in spec order', () {
      final out = body(
        generate({
          'pair': [param('b'), param('a')],
        }),
        'pair',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      b,\n'
          '      a,\n'
          '    ];\n',
        ),
      );
    });

    test('an optional before a required one sends null in its slot', () {
      final out = body(
        generate({
          'lead': [optional('a'), param('b')],
        }),
        'lead',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      a,\n'
          '      b,\n'
          '    ];\n',
        ),
      );
    });

    test('an optional that converts is encoded null-aware in its slot', () {
      final out = body(
        generate({
          'mix': [
            optional('a', SchemaReference('Leaf')),
            param('b', SchemaReference('Leaf')),
            optional('c', SchemaReference('Leaf')),
            optional('d', ListType(SchemaReference('Leaf'))),
            optional('flag', const PrimitiveType('bool')),
          ],
        }),
        'mix',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      a?.toJson(),\n'
          '      b.toJson(),\n'
          '      if (c != null || d != null || flag != null) c?.toJson(),\n'
          '      if (d != null || flag != null) '
          'd?.map((e) => e.toJson()).toList(),\n'
          '      if (flag != null) flag,\n'
          '    ];\n',
        ),
      );
    });

    test('the last optional is encoded promoted, as before', () {
      final out = body(
        generate({
          'put': [param('key'), optional('leaf', SchemaReference('Leaf'))],
        }),
        'put',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      key,\n'
          '      if (leaf != null) leaf.toJson(),\n'
          '    ];\n',
        ),
      );
    });

    test('a required nullable parameter keeps its slot as null', () {
      final out = body(
        generate({
          'maybe': [
            param('leaf', NullableType(SchemaReference('Leaf'))),
            param('tail'),
          ],
        }),
        'maybe',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      leaf?.toJson(),\n'
          '      tail,\n'
          '    ];\n',
        ),
      );
    });

    test('only optional parameters, all trailing', () {
      final out = body(
        generate({
          'opts': [optional('a'), optional('b')],
        }),
        'opts',
      );
      expect(
        out,
        contains(
          '    final params = <dynamic>[\n'
          '      if (a != null || b != null) a,\n'
          '      if (b != null) b,\n'
          '    ];\n',
        ),
      );
    });

    test('a method without parameters sends an empty array', () {
      final out = body(generate({'ping': []}), 'ping');
      expect(
        out,
        contains(
          "    final result = await _client.call('api.ping', const <dynamic>[]);",
        ),
      );
    });
  });
}
