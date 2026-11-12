import 'package:blocks_codegen/src/model.dart';
import 'package:blocks_codegen/src/builder.dart';
import 'package:test/test.dart';

void main() {
  group('namespace grouping', () {
    test('splits dotted names into namespaces', () {
      final model = CodegenModelBuilder().build(
        RpcModel(
          title: 't',
          version: '1',
          schemas: {},
          methods: [
            RpcMethod(
              name: 'api.create',
              params: [],
              result: const PrimitiveRef('String'),
            ),
            RpcMethod(
              name: 'api.delete',
              params: [],
              result: const PrimitiveRef('String'),
            ),
            RpcMethod(
              name: 'auth.login',
              params: [],
              result: const PrimitiveRef('String'),
            ),
          ],
        ),
      );
      expect(model.namespaces.length, 2);
      expect(model.namespaces[0].name, 'api');
      expect(model.namespaces[0].operations.length, 2);
      expect(model.namespaces[1].name, 'auth');
    });
  });

  group('type resolution', () {
    test('resolves SchemaRefRef to SchemaReference', () {
      final model = CodegenModelBuilder().build(
        RpcModel(
          title: 't',
          version: '1',
          schemas: {
            'Todo': const InlineObjectRef(
              properties: {'id': PrimitiveRef('String')},
              required: {'id'},
            ),
          },
          methods: [
            RpcMethod(
              name: 'api.get',
              params: [],
              result: const SchemaRefRef('Todo'),
            ),
          ],
        ),
      );
      expect(model.namespaces[0].operations[0].result, isA<SchemaReference>());
      expect(
        (model.namespaces[0].operations[0].result as SchemaReference).name,
        'Todo',
      );
    });
  });

  group('discriminated union', () {
    test('produces SealedClassType with variants', () {
      final model = CodegenModelBuilder().build(
        RpcModel(
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
                        required: {'x'},
                      ),
                      UnionVariant(
                        discriminantValue: 'b',
                        properties: {'y': PrimitiveRef('num')},
                        required: {'y'},
                      ),
                    ],
                  ),
                ),
              ],
              result: const PrimitiveRef('void'),
            ),
          ],
        ),
      );
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
      const union = DiscriminatedUnionRef(
        discriminant: 'type',
        variants: [
          UnionVariant(
            discriminantValue: 'a',
            properties: {'x': PrimitiveRef('String')},
            required: {'x'},
          ),
          UnionVariant(
            discriminantValue: 'b',
            properties: {'y': PrimitiveRef('int')},
            required: {'y'},
          ),
        ],
      );
      final model = CodegenModelBuilder().build(
        RpcModel(
          title: 't',
          version: '1',
          schemas: {},
          methods: [
            RpcMethod(
              name: 'api.first',
              params: [
                RpcParam(name: 'input', isRequired: true, schema: union),
              ],
              result: const PrimitiveRef('void'),
            ),
            RpcMethod(
              name: 'api.second',
              params: [RpcParam(name: 'data', isRequired: true, schema: union)],
              result: const PrimitiveRef('void'),
            ),
          ],
        ),
      );
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
      final model = CodegenModelBuilder().build(
        RpcModel(
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
                  'done': PrimitiveRef('bool'),
                },
                required: {'title', 'done'},
              ),
            ),
          ],
        ),
      );
      final result = model.namespaces[0].operations[0].result;
      expect(result, isA<RecordType>());
      expect((result as RecordType).name, 'Todo');
      expect(model.types.containsKey('Todo'), isTrue);
      // The synthesized fallback name must NOT be emitted.
      expect(model.types.containsKey('GetResult'), isFalse);
    });

    test('falls back to {Method}Result when no name is declared', () {
      final model = CodegenModelBuilder().build(
        RpcModel(
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
                  'done': PrimitiveRef('bool'),
                },
                required: {'title', 'done'},
              ),
            ),
          ],
        ),
      );
      final result = model.namespaces[0].operations[0].result as RecordType;
      expect(result.name, 'GetResult');
    });

    test('declared name wins over generic shape-based renaming', () {
      // Shape {success: bool} would normally be renamed to SuccessResult.
      final model = CodegenModelBuilder().build(
        RpcModel(
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
        ),
      );
      final result = model.namespaces[0].operations[0].result as RecordType;
      expect(result.name, 'DoThingOutcome');
      expect(model.types.containsKey('SuccessResult'), isFalse);
    });

    test('distinct declared names keep cross-namespace results distinct', () {
      // On main (no namespace prefix) both would synthesize "ListResult".
      final model = CodegenModelBuilder().build(
        RpcModel(
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
        ),
      );
      expect(model.types.containsKey('UsersListResult'), isTrue);
      expect(model.types.containsKey('PostsListResult'), isTrue);
    });
  });

  group('structural dedup keys', () {
    List<ResolvedType> results(List<TypeRef> refs) {
      final model = CodegenModelBuilder().build(
        RpcModel(
          title: 't',
          version: '1',
          schemas: {},
          methods: [
            for (final (i, r) in refs.indexed)
              RpcMethod(name: 'api.m$i', params: [], result: r),
          ],
        ),
      );
      return model.namespaces[0].operations.map((o) => o.result).toList();
    }

    InlineObjectRef channelResult(InlineObjectRef message) => InlineObjectRef(
      properties: {
        'channel': TransferableRef(
          blocksType: 'realtime/channel',
          typeArgs: [message],
        ),
      },
      required: {'channel'},
    );

    test('channels with different payloads keep distinct result types', () {
      final r = results([
        channelResult(
          const InlineObjectRef(
            properties: {'text': PrimitiveRef('String')},
            required: {'text'},
          ),
        ),
        channelResult(
          const InlineObjectRef(
            properties: {'count': PrimitiveRef('int')},
            required: {'count'},
          ),
        ),
      ]);
      expect(r[0], isA<RecordType>());
      expect(r[1], isA<RecordType>());
      expect((r[1] as RecordType).name, isNot((r[0] as RecordType).name));
    });

    test('an open payload does not merge into a closed one', () {
      final r = results([
        channelResult(
          const InlineObjectRef(
            properties: {'text': PrimitiveRef('String')},
            required: {'text'},
          ),
        ),
        channelResult(
          const InlineObjectRef(
            properties: {'text': PrimitiveRef('String')},
            required: {'text'},
            additionalProperties: PrimitiveRef('int'),
          ),
        ),
      ]);
      final first = (r[0] as RecordType).fields.single.type as TransferableType;
      final second =
          (r[1] as RecordType).fields.single.type as TransferableType;
      expect(first.typeArgs.single, isA<RecordType>());
      expect(second.typeArgs.single, isA<RecordType>());
      expect(
        (second.typeArgs.single as RecordType).additionalProperties,
        isNotNull,
      );
    });

    test('unions with different embedded unions stay distinct', () {
      DiscriminatedUnionRef hybrid(String innerArm) => DiscriminatedUnionRef(
        discriminant: 'type',
        variants: [
          UnionVariant(
            discriminantValue: 'a',
            properties: const {'x': PrimitiveRef('String')},
            required: const {'x'},
            embeddedUnion: DiscriminatedUnionRef(
              discriminant: 'kind',
              variants: [
                UnionVariant(
                  discriminantValue: innerArm,
                  properties: const {},
                  required: const {},
                ),
              ],
            ),
          ),
        ],
      );
      final r = results([hybrid('one'), hybrid('two')]);
      expect(r[0], isA<SealedClassType>());
      expect(r[1], isA<SealedClassType>());
      expect(
        (r[1] as SealedClassType).name,
        isNot((r[0] as SealedClassType).name),
      );
    });
  });

  group('identifier collision warnings', () {
    CodegenModel build(List<RpcMethod> methods) => CodegenModelBuilder().build(
      RpcModel(title: 't', version: '1', schemas: {}, methods: methods),
    );

    test('two namespaces that generate one class are a warning', () {
      final model = build([
        RpcMethod(name: 'a.b.x', params: [], result: const PrimitiveRef('int')),
        RpcMethod(name: 'aB.y', params: [], result: const PrimitiveRef('int')),
      ]);
      expect(model.warnings, hasLength(1));
      expect(
        model.warnings.single,
        allOf(contains("'a.b'"), contains("'aB'"), contains(r'ABApi$')),
      );
    });

    test('two fields that generate one identifier are a warning', () {
      final model = build([
        RpcMethod(
          name: 'api.get',
          params: [],
          result: const InlineObjectRef(
            properties: {'d-e': PrimitiveRef('int'), 'dE': PrimitiveRef('int')},
            required: {},
          ),
        ),
      ]);
      expect(model.warnings, hasLength(1));
      expect(
        model.warnings.single,
        allOf(contains("'d-e'"), contains("'dE'"), contains(r'dE$')),
      );
    });

    test('names that stay distinct are not a warning', () {
      final model = build([
        RpcMethod(
          name: 'api.get',
          params: [
            RpcParam(
              name: 'class',
              isRequired: true,
              schema: const PrimitiveRef('int'),
            ),
          ],
          result: const InlineObjectRef(
            properties: {
              '_id': PrimitiveRef('int'),
              'd-e': PrimitiveRef('int'),
            },
            required: {},
          ),
        ),
      ]);
      expect(model.warnings, isEmpty);
    });
  });
}
