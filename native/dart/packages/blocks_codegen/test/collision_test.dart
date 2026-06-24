import 'package:blocks_codegen/src/model.dart';
import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:test/test.dart';

/// Irreducible collision: even full namespace+method+param qualification
/// collapses to the same string.
///   api.foo    param barInput -> Api + Foo    + BarInput = ApiFooBarInput
///   api.fooBar param input    -> Api + FooBar + Input    = ApiFooBarInput
/// The two param shapes are structurally distinct, so this is a real conflict.
RpcModel _irreducible({bool reversed = false}) {
  final foo = RpcMethod(
    name: 'api.foo',
    params: [
      RpcParam(
          name: 'barInput',
          isRequired: true,
          schema: const InlineObjectRef(
              properties: {'a': PrimitiveRef('String')}, required: {'a'})),
    ],
    result: const PrimitiveRef('void'),
  );
  final fooBar = RpcMethod(
    name: 'api.fooBar',
    params: [
      RpcParam(
          name: 'input',
          isRequired: true,
          schema: const InlineObjectRef(
              properties: {'b': PrimitiveRef('int')}, required: {'b'})),
    ],
    result: const PrimitiveRef('void'),
  );
  return RpcModel(
    title: 't',
    version: '1',
    schemas: {},
    methods: reversed ? [fooBar, foo] : [foo, fooBar],
  );
}

/// A flat field `addressContact` and a nested path `address` -> `contact`,
/// both structurally distinct, both synthesize `GetResultAddressContact`.
/// Results are not qualified, so this collision is irreducible too.
RpcModel _nestedVsFlat() {
  return RpcModel(
    title: 't',
    version: '1',
    schemas: {},
    methods: [
      RpcMethod(
        name: 'api.get',
        params: [],
        result: const InlineObjectRef(
          properties: {
            'addressContact': InlineObjectRef(
                properties: {'x': PrimitiveRef('String')}, required: {'x'}),
            'address': InlineObjectRef(
              properties: {
                'contact': InlineObjectRef(
                    properties: {'y': PrimitiveRef('int')}, required: {'y'}),
              },
              required: {'contact'},
            ),
          },
          required: {'addressContact', 'address'},
        ),
      ),
    ],
  );
}

void main() {
  group('param qualification', () {
    test(
        'inline param object types are qualified by namespace + method + param',
        () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
              name: 'users.create',
              params: [
                RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'name': PrimitiveRef('String')},
                        required: {'name'})),
              ],
              result: const PrimitiveRef('void')),
          RpcMethod(
              name: 'posts.create',
              params: [
                RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'title': PrimitiveRef('String')},
                        required: {'title'})),
              ],
              result: const PrimitiveRef('void')),
        ],
      ));
      expect(model.types.containsKey('UsersCreateInput'), isTrue);
      expect(model.types.containsKey('PostsCreateInput'), isTrue);
      // No bare/unqualified name and no collision -> no warnings.
      expect(model.types.containsKey('Input'), isFalse);
      expect(model.warnings, isEmpty);
    });

    test(
        'structurally identical param shapes still dedup to one qualified type',
        () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
              name: 'api.alpha',
              params: [
                RpcParam(
                    name: 'config',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'a': PrimitiveRef('String')},
                        required: {'a'})),
              ],
              result: const PrimitiveRef('void')),
          RpcMethod(
              name: 'api.beta',
              params: [
                RpcParam(
                    name: 'config',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'a': PrimitiveRef('String')},
                        required: {'a'})),
              ],
              result: const PrimitiveRef('void')),
        ],
      ));
      // First creates the qualified type; the identical second dedups to it.
      expect(
          model.types.values
              .whereType<RecordType>()
              .where((r) => r.name == 'ApiAlphaConfig')
              .length,
          1);
      final ops = model.namespaces.expand((n) => n.operations).toList();
      expect((ops[0].params[0].type as RecordType).name, 'ApiAlphaConfig');
      expect((ops[1].params[0].type as SchemaReference).name, 'ApiAlphaConfig');
      expect(model.warnings, isEmpty);
    });
  });

  group('default: auto-disambiguate + warn', () {
    test('irreducible param collision is suffixed (not thrown) and warned', () {
      final model = CodegenModelBuilder().build(_irreducible());
      // No throw; both distinct types present with a deterministic suffix.
      expect(model.types.containsKey('ApiFooBarInput'), isTrue);
      expect(model.types.containsKey('ApiFooBarInput2'), isTrue);
      // Smallest canonical key (api.foo#param:barInput) keeps the base name.
      final byMethod = {
        for (final op in model.namespaces.expand((n) => n.operations))
          op.fullName: op,
      };
      expect((byMethod['api.foo']!.params[0].type as RecordType).name,
          'ApiFooBarInput');
      expect((byMethod['api.fooBar']!.params[0].type as RecordType).name,
          'ApiFooBarInput2');
      // Loud, actionable warning naming both sources + chosen names.
      expect(model.warnings, hasLength(1));
      expect(
          model.warnings.single,
          allOf(
            contains('`ApiFooBarInput`'),
            contains('api.foo (param "barInput")'),
            contains('api.fooBar (param "input")'),
            contains('ApiFooBarInput2'),
            contains('--fail-on-collision'),
          ));
    });

    test('nested-vs-flat result collision is suffixed and warned', () {
      final model = CodegenModelBuilder().build(_nestedVsFlat());
      expect(model.types.containsKey('GetResultAddressContact'), isTrue);
      expect(model.types.containsKey('GetResultAddressContact2'), isTrue);
      expect(model.warnings, hasLength(1));
      expect(
          model.warnings.single,
          allOf(
            contains('api.get (result: addressContact)'),
            contains('api.get (result: address.contact)'),
          ));
    });

    test('warns once per conflicting group', () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
              name: 'api.foo',
              params: [
                RpcParam(
                    name: 'barInput',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'a': PrimitiveRef('String')},
                        required: {'a'})),
              ],
              result: const PrimitiveRef('void')),
          RpcMethod(
              name: 'api.fooBar',
              params: [
                RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'b': PrimitiveRef('int')},
                        required: {'b'})),
              ],
              result: const PrimitiveRef('void')),
          RpcMethod(
              name: 'api.bar',
              params: [
                RpcParam(
                    name: 'bazInput',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'c': PrimitiveRef('String')},
                        required: {'c'})),
              ],
              result: const PrimitiveRef('void')),
          RpcMethod(
              name: 'api.barBaz',
              params: [
                RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const InlineObjectRef(
                        properties: {'d': PrimitiveRef('bool')},
                        required: {'d'})),
              ],
              result: const PrimitiveRef('void')),
        ],
      ));
      expect(model.warnings, hasLength(2));
    });

    test('is deterministic and order-independent', () {
      final a = CodegenModelBuilder().build(_irreducible());
      final b = CodegenModelBuilder().build(_irreducible(reversed: true));
      String nameFor(CodegenModel m, String method) {
        final op = m.namespaces
            .expand((n) => n.operations)
            .firstWhere((o) => o.fullName == method);
        return (op.params[0].type as RecordType).name;
      }

      expect(nameFor(a, 'api.foo'), 'ApiFooBarInput');
      expect(nameFor(a, 'api.fooBar'), 'ApiFooBarInput2');
      expect(nameFor(b, 'api.foo'), 'ApiFooBarInput');
      expect(nameFor(b, 'api.fooBar'), 'ApiFooBarInput2');
    });

    test('same spec builds byte-identical output across runs', () {
      final out1 = const DartCodeGenerator()
          .generate(CodegenModelBuilder().build(_irreducible()));
      final out2 = const DartCodeGenerator()
          .generate(CodegenModelBuilder().build(_irreducible()));
      expect(out1, out2);
      expect(out1, contains('class ApiFooBarInput {'));
      expect(out1, contains('class ApiFooBarInput2 {'));
    });
  });

  group('--fail-on-collision (opt-in)', () {
    test('throws on an irreducible collision, listing both sources', () {
      expect(
        () => CodegenModelBuilder(failOnCollision: true).build(_irreducible()),
        throwsA(isA<NamingConflictException>().having(
            (e) => e.message,
            'message',
            allOf(
              contains('`ApiFooBarInput`'),
              contains('api.foo (param "barInput")'),
              contains('api.fooBar (param "input")'),
              contains('disambiguate'),
            ))),
      );
    });

    test('does not throw when there is no collision', () {
      // Distinct qualified names -> no conflict even in strict mode.
      expect(
        () => CodegenModelBuilder(failOnCollision: true).build(RpcModel(
          title: 't',
          version: '1',
          schemas: {},
          methods: [
            RpcMethod(
                name: 'users.create',
                params: [
                  RpcParam(
                      name: 'input',
                      isRequired: true,
                      schema: const InlineObjectRef(
                          properties: {'name': PrimitiveRef('String')},
                          required: {'name'})),
                ],
                result: const PrimitiveRef('void')),
            RpcMethod(
                name: 'posts.create',
                params: [
                  RpcParam(
                      name: 'input',
                      isRequired: true,
                      schema: const InlineObjectRef(
                          properties: {'title': PrimitiveRef('String')},
                          required: {'title'})),
                ],
                result: const PrimitiveRef('void')),
          ],
        )),
        returnsNormally,
      );
    });
  });
}
