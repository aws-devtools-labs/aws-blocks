import 'package:blocks_codegen/src/model.dart';
import 'package:blocks_codegen/src/builder.dart';
import 'package:test/test.dart';

void main() {
  group('namespace grouping', () {
    test('splits dotted names into namespaces', () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
              name: 'api.create',
              params: [],
              result: const PrimitiveRef('String')),
          RpcMethod(
              name: 'api.delete',
              params: [],
              result: const PrimitiveRef('String')),
          RpcMethod(
              name: 'auth.login',
              params: [],
              result: const PrimitiveRef('String')),
        ],
      ));
      expect(model.namespaces.length, 2);
      expect(model.namespaces[0].name, 'api');
      expect(model.namespaces[0].operations.length, 2);
      expect(model.namespaces[1].name, 'auth');
    });
  });

  group('type resolution', () {
    test('resolves SchemaRefRef to SchemaReference', () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {
          'Todo': const InlineObjectRef(
              properties: {'id': PrimitiveRef('String')}, required: {'id'})
        },
        methods: [
          RpcMethod(
              name: 'api.get', params: [], result: const SchemaRefRef('Todo')),
        ],
      ));
      expect(model.namespaces[0].operations[0].result, isA<SchemaReference>());
      expect((model.namespaces[0].operations[0].result as SchemaReference).name,
          'Todo');
    });
  });

  group('discriminated union', () {
    test('produces SealedClassType with variants', () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
              name: 'api.set',
              params: [
                RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const DiscriminatedUnionRef(
                      discriminant: 'type',
                      variants: [
                        UnionVariant(
                            discriminantValue: 'a',
                            properties: {'x': PrimitiveRef('String')},
                            required: {'x'}),
                        UnionVariant(
                            discriminantValue: 'b',
                            properties: {'y': PrimitiveRef('num')},
                            required: {'y'}),
                      ],
                    )),
              ],
              result: const PrimitiveRef('void')),
        ],
      ));
      final paramType = model.namespaces[0].operations[0].params[0].type;
      expect(paramType, isA<SealedClassType>());
      final sealed = paramType as SealedClassType;
      expect(sealed.discriminant, 'type');
      expect(sealed.variants.length, 2);
    });
  });

  group('ported dedup (from #682)', () {
    test('structurally identical sealed unions dedup to a single type', () {
      // Main lacks sealed-class dedup entirely; the port merges identical unions.
      const union = DiscriminatedUnionRef(discriminant: 'type', variants: [
        UnionVariant(
            discriminantValue: 'a',
            properties: {'x': PrimitiveRef('String')},
            required: {'x'}),
        UnionVariant(
            discriminantValue: 'b',
            properties: {'y': PrimitiveRef('int')},
            required: {'y'}),
      ]);
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
              name: 'api.first',
              params: [
                RpcParam(name: 'input', isRequired: true, schema: union),
              ],
              result: const PrimitiveRef('void')),
          RpcMethod(
              name: 'api.second',
              params: [
                RpcParam(name: 'data', isRequired: true, schema: union),
              ],
              result: const PrimitiveRef('void')),
        ],
      ));
      final ops = model.namespaces.expand((n) => n.operations).toList();
      expect((ops[0].params[0].type as SealedClassType).name, 'ApiFirstInput');
      expect(ops[1].params[0].type, isA<SchemaReference>());
      expect((ops[1].params[0].type as SchemaReference).name, 'ApiFirstInput');
      expect(model.types.values.whereType<SealedClassType>().length, 1);
    });
  });

  group('declared result name', () {
    test('honors declared result name as the inline result type identity', () {
      // Bug repro: api.get with result content-descriptor named "Todo".
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
            name: 'api.get',
            params: [],
            resultName: 'Todo',
            result: const InlineObjectRef(
              properties: {
                'title': PrimitiveRef('String'),
                'done': PrimitiveRef('bool')
              },
              required: {'title', 'done'},
            ),
          ),
        ],
      ));
      final result = model.namespaces[0].operations[0].result;
      expect(result, isA<RecordType>());
      expect((result as RecordType).name, 'Todo');
      expect(model.types.containsKey('Todo'), isTrue);
      // The synthesized fallback name must NOT be emitted.
      expect(model.types.containsKey('GetResult'), isFalse);
    });

    test('falls back to {Method}Result when no name is declared', () {
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
            name: 'api.get',
            params: [],
            result: const InlineObjectRef(
              properties: {
                'title': PrimitiveRef('String'),
                'done': PrimitiveRef('bool')
              },
              required: {'title', 'done'},
            ),
          ),
        ],
      ));
      final result = model.namespaces[0].operations[0].result as RecordType;
      expect(result.name, 'GetResult');
    });

    test('declared name wins over generic shape-based renaming', () {
      // Shape {success: bool} would normally be renamed to SuccessResult.
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
            name: 'api.doThing',
            params: [],
            resultName: 'DoThingOutcome',
            result: const InlineObjectRef(
              properties: {'success': PrimitiveRef('bool')},
              required: {'success'},
            ),
          ),
        ],
      ));
      final result = model.namespaces[0].operations[0].result as RecordType;
      expect(result.name, 'DoThingOutcome');
      expect(model.types.containsKey('SuccessResult'), isFalse);
    });

    test('distinct declared names keep cross-namespace results distinct', () {
      // On main (no namespace prefix) both would synthesize "ListResult".
      final model = CodegenModelBuilder().build(RpcModel(
        title: 't',
        version: '1',
        schemas: {},
        methods: [
          RpcMethod(
            name: 'users.list',
            params: [],
            resultName: 'UsersListResult',
            result: const InlineObjectRef(
              properties: {'users': ArrayRef(PrimitiveRef('String'))},
              required: {'users'},
            ),
          ),
          RpcMethod(
            name: 'posts.list',
            params: [],
            resultName: 'PostsListResult',
            result: const InlineObjectRef(
              properties: {'posts': ArrayRef(PrimitiveRef('String'))},
              required: {'posts'},
            ),
          ),
        ],
      ));
      expect(model.types.containsKey('UsersListResult'), isTrue);
      expect(model.types.containsKey('PostsListResult'), isTrue);
    });
  });
}
