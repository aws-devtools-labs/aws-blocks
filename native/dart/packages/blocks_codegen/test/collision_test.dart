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
          properties: {'a': PrimitiveRef('String')},
          required: {'a'},
        ),
      ),
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
          properties: {'b': PrimitiveRef('int')},
          required: {'b'},
        ),
      ),
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
              properties: {'x': PrimitiveRef('String')},
              required: {'x'},
            ),
            'address': InlineObjectRef(
              properties: {
                'contact': InlineObjectRef(
                  properties: {'y': PrimitiveRef('int')},
                  required: {'y'},
                ),
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

/// `setState`-style methods (`ns.method`) whose input unions share the
/// `signUp` and `signOut` arms but differ in shape. Dart names an `…Input`
/// union's arms `<Value>Input`, so every union's arm wants `SignUpInput`.
/// [extra] adds one more arm to the last union only. [fields] sets how many
/// fields each method's `signUp` arm has (by default `i + 1`, all distinct),
/// so that equal counts make structurally identical, deduplicated unions.
RpcModel _sharedArmNames({
  bool reversed = false,
  List<String> methods = const ['basic.setState', 'cognito.setState'],
  Map<String, TypeRef> schemas = const {},
  String? extra,
  List<int>? fields,
}) {
  RpcMethod setState(int i) {
    final signUp = {
      for (var f = 0; f < (fields?[i] ?? i + 1); f++)
        'f$f': const PrimitiveRef('String'),
    };
    return RpcMethod(
      name: methods[i],
      params: [
        RpcParam(
          name: 'input',
          isRequired: true,
          schema: DiscriminatedUnionRef(
            discriminant: 'action',
            variants: [
              UnionVariant(
                discriminantValue: 'signUp',
                properties: signUp,
                required: signUp.keys.toSet(),
              ),
              const UnionVariant(
                discriminantValue: 'signOut',
                properties: {},
                required: {},
              ),
              if (extra != null && i == methods.length - 1)
                UnionVariant(
                  discriminantValue: extra,
                  properties: const {},
                  required: const {},
                ),
            ],
          ),
        ),
      ],
      result: const PrimitiveRef('void'),
    );
  }

  final built = [for (var i = 0; i < methods.length; i++) setState(i)];
  return RpcModel(
    title: 't',
    version: '1',
    schemas: schemas,
    methods: reversed ? built.reversed.toList() : built,
  );
}

/// The generated library's top-level class names, checked to be distinct.
Set<String> _classes(CodegenModel model) {
  final out = const DartCodeGenerator().generate(model);
  final classes = RegExp(
    r'^class (\w+)',
    multiLine: true,
  ).allMatches(out).map((m) => m[1]!).toList();
  expect(classes.toSet(), hasLength(classes.length), reason: '$classes');
  return classes.toSet();
}

void main() {
  group('param qualification', () {
    test(
      'inline param object types are qualified by namespace + method + param',
      () {
        final model = CodegenModelBuilder().build(
          RpcModel(
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
                      required: {'name'},
                    ),
                  ),
                ],
                result: const PrimitiveRef('void'),
              ),
              RpcMethod(
                name: 'posts.create',
                params: [
                  RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const InlineObjectRef(
                      properties: {'title': PrimitiveRef('String')},
                      required: {'title'},
                    ),
                  ),
                ],
                result: const PrimitiveRef('void'),
              ),
            ],
          ),
        );
        expect(model.types.containsKey('UsersCreateInput'), isTrue);
        expect(model.types.containsKey('PostsCreateInput'), isTrue);
        // No bare/unqualified name and no collision -> no warnings.
        expect(model.types.containsKey('Input'), isFalse);
        expect(model.warnings, isEmpty);
      },
    );

    test(
      'structurally identical param shapes still dedup to one qualified type',
      () {
        final model = CodegenModelBuilder().build(
          RpcModel(
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
                      required: {'a'},
                    ),
                  ),
                ],
                result: const PrimitiveRef('void'),
              ),
              RpcMethod(
                name: 'api.beta',
                params: [
                  RpcParam(
                    name: 'config',
                    isRequired: true,
                    schema: const InlineObjectRef(
                      properties: {'a': PrimitiveRef('String')},
                      required: {'a'},
                    ),
                  ),
                ],
                result: const PrimitiveRef('void'),
              ),
            ],
          ),
        );
        // First creates the qualified type; the identical second dedups to it.
        expect(
          model.types.values
              .whereType<RecordType>()
              .where((r) => r.name == 'ApiAlphaConfig')
              .length,
          1,
        );
        final ops = model.namespaces.expand((n) => n.operations).toList();
        expect((ops[0].params[0].type as RecordType).name, 'ApiAlphaConfig');
        expect(
          (ops[1].params[0].type as SchemaReference).name,
          'ApiAlphaConfig',
        );
        expect(model.warnings, isEmpty);
      },
    );
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
      expect(
        (byMethod['api.foo']!.params[0].type as RecordType).name,
        'ApiFooBarInput',
      );
      expect(
        (byMethod['api.fooBar']!.params[0].type as RecordType).name,
        'ApiFooBarInput2',
      );
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
        ),
      );
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
        ),
      );
    });

    test('warns once per conflicting group', () {
      final model = CodegenModelBuilder().build(
        RpcModel(
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
                    required: {'a'},
                  ),
                ),
              ],
              result: const PrimitiveRef('void'),
            ),
            RpcMethod(
              name: 'api.fooBar',
              params: [
                RpcParam(
                  name: 'input',
                  isRequired: true,
                  schema: const InlineObjectRef(
                    properties: {'b': PrimitiveRef('int')},
                    required: {'b'},
                  ),
                ),
              ],
              result: const PrimitiveRef('void'),
            ),
            RpcMethod(
              name: 'api.bar',
              params: [
                RpcParam(
                  name: 'bazInput',
                  isRequired: true,
                  schema: const InlineObjectRef(
                    properties: {'c': PrimitiveRef('String')},
                    required: {'c'},
                  ),
                ),
              ],
              result: const PrimitiveRef('void'),
            ),
            RpcMethod(
              name: 'api.barBaz',
              params: [
                RpcParam(
                  name: 'input',
                  isRequired: true,
                  schema: const InlineObjectRef(
                    properties: {'d': PrimitiveRef('bool')},
                    required: {'d'},
                  ),
                ),
              ],
              result: const PrimitiveRef('void'),
            ),
          ],
        ),
      );
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
      final out1 = const DartCodeGenerator().generate(
        CodegenModelBuilder().build(_irreducible()),
      );
      final out2 = const DartCodeGenerator().generate(
        CodegenModelBuilder().build(_irreducible()),
      );
      expect(out1, out2);
      expect(out1, contains('class ApiFooBarInput {'));
      expect(out1, contains('class ApiFooBarInput2 {'));
    });
  });

  group('--fail-on-collision (opt-in)', () {
    test('throws on an irreducible collision, listing both sources', () {
      expect(
        () => CodegenModelBuilder(failOnCollision: true).build(_irreducible()),
        throwsA(
          isA<NamingConflictException>().having(
            (e) => e.message,
            'message',
            allOf(
              contains('`ApiFooBarInput`'),
              contains('api.foo (param "barInput")'),
              contains('api.fooBar (param "input")'),
              contains('disambiguate'),
            ),
          ),
        ),
      );
    });

    test('does not throw when there is no collision', () {
      // Distinct qualified names -> no conflict even in strict mode.
      expect(
        () => CodegenModelBuilder(failOnCollision: true).build(
          RpcModel(
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
                      required: {'name'},
                    ),
                  ),
                ],
                result: const PrimitiveRef('void'),
              ),
              RpcMethod(
                name: 'posts.create',
                params: [
                  RpcParam(
                    name: 'input',
                    isRequired: true,
                    schema: const InlineObjectRef(
                      properties: {'title': PrimitiveRef('String')},
                      required: {'title'},
                    ),
                  ),
                ],
                result: const PrimitiveRef('void'),
              ),
            ],
          ),
        ),
        returnsNormally,
      );
    });
  });

  group('a union embedded in an arm, deduplicated', () {
    test('keeps the embedded union in every namespace', () {
      // `alpha` and `beta` declare one union; its `confirmSignIn` arm embeds
      // a `challenge` union, which the second occurrence deduplicates.
      RpcMethod setState(String ns) => RpcMethod(
        name: '$ns.setState',
        params: [
          RpcParam(
            name: 'input',
            isRequired: true,
            schema: const DiscriminatedUnionRef(
              discriminant: 'action',
              variants: [
                UnionVariant(
                  discriminantValue: 'confirmSignIn',
                  properties: {'session': PrimitiveRef('String')},
                  required: {'session'},
                  embeddedUnion: DiscriminatedUnionRef(
                    discriminant: 'challenge',
                    variants: [
                      UnionVariant(
                        discriminantValue: 'code',
                        properties: {'code': PrimitiveRef('String')},
                        required: {'code'},
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
        result: const PrimitiveRef('void'),
      );
      final model = CodegenModelBuilder().build(
        RpcModel(
          title: 't',
          version: '1',
          schemas: {},
          methods: [setState('alpha'), setState('beta')],
        ),
      );
      for (final ns in model.namespaces) {
        final type = ns.operations.single.params.single.type;
        final union = type is SchemaReference ? model.types[type.name] : type;
        expect(
          (union! as SealedClassType).variants.single.embeddedUnion,
          isNotNull,
          reason: ns.name,
        );
      }
      final out = const DartCodeGenerator().generate(model);
      expect(
        RegExp(
          r'^class \w*ConfirmSignInInput extends',
          multiLine: true,
        ).allMatches(out),
        hasLength(1),
      );
      expect(out, contains('final ConfirmSignInInputChallenge challenge;'));
    });
  });

  group('union arms shared by two unions', () {
    test('take the namespace prefix, whatever the spec order', () {
      final names = <Set<String>>[];
      for (final reversed in [false, true]) {
        final model = CodegenModelBuilder().build(
          _sharedArmNames(reversed: reversed),
        );
        final out = const DartCodeGenerator().generate(model);
        names.add(_classes(model));
        // The union whose name sorts first keeps the short names.
        expect(out, contains('class SignUpInput extends BasicSetStateInput {'));
        expect(
          out,
          contains('class SignOutInput extends BasicSetStateInput {'),
        );
        expect(
          out,
          contains('class CognitoSignUpInput extends CognitoSetStateInput {'),
        );
        expect(
          out,
          contains('class CognitoSignOutInput extends CognitoSetStateInput {'),
        );
        expect(
          out,
          contains("case 'signUp': return CognitoSignUpInput.fromJson(json);"),
        );
        // One compact line per renamed union.
        expect(model.warnings, [
          'Naming conflict: union CognitoSetStateInput shares Dart arm class '
              'names with another type; generated as SignUpInput -> '
              'CognitoSignUpInput, SignOutInput -> CognitoSignOutInput. '
              'Rename the arms or the union in your spec to keep the short '
              'names.',
        ]);
      }
      expect(names.first, names.last);
    });

    test('in one namespace fall back to the union name', () {
      for (final reversed in [false, true]) {
        final model = CodegenModelBuilder().build(
          _sharedArmNames(
            reversed: reversed,
            methods: ['basic.setState', 'cognito.setState', 'cognito.update'],
          ),
        );
        final classes = _classes(model);
        expect(classes, containsAll(['SignUpInput', 'CognitoSignUpInput']));
        expect(
          classes,
          containsAll([
            'CognitoUpdateInputSignUp',
            'CognitoUpdateInputSignOut',
          ]),
        );
        expect(
          model.warnings,
          contains(
            contains(
              'union CognitoUpdateInput shares Dart arm class names with '
              'another type; generated as SignUpInput -> '
              'CognitoUpdateInputSignUp, SignOutInput -> '
              'CognitoUpdateInputSignOut.',
            ),
          ),
        );
      }
    });

    test('fall back to the union name when the prefixed name is taken', () {
      for (final reversed in [false, true]) {
        // Taken by a model.
        final byModel = CodegenModelBuilder().build(
          _sharedArmNames(
            reversed: reversed,
            schemas: {
              'CognitoSignUpInput': const InlineObjectRef(
                properties: {'x': PrimitiveRef('String')},
                required: {'x'},
              ),
            },
          ),
        );
        expect(
          _classes(byModel),
          containsAll([
            'CognitoSignUpInput',
            'CognitoSetStateInputSignUp',
            'CognitoSignOutInput',
          ]),
        );

        // Taken by another union's own arm (`cognitoSignUp` in `x.setState`),
        // which keeps it.
        final byArm = CodegenModelBuilder().build(
          _sharedArmNames(
            reversed: reversed,
            methods: ['basic.setState', 'cognito.setState', 'x.setState'],
            extra: 'cognitoSignUp',
          ),
        );
        final classes = _classes(byArm);
        expect(
          classes,
          containsAll([
            'CognitoSignUpInput',
            'CognitoSetStateInputSignUp',
            'XSignUpInput',
          ]),
        );
        final out = const DartCodeGenerator().generate(byArm);
        expect(
          out,
          contains('class CognitoSignUpInput extends XSetStateInput {'),
        );
      }
    });

    test('of a union two namespaces share take one prefix in any order', () {
      // `bb` and `zz` declare one union, deduplicated into one class. Its
      // arms take the prefix of the namespace that sorts first, whichever
      // the spec lists first. (The union class itself is still named after
      // the first one listed.)
      final classes = [
        for (final methods in [
          ['aa.setState', 'bb.setState', 'zz.setState'],
          ['aa.setState', 'zz.setState', 'bb.setState'],
        ])
          _classes(
            CodegenModelBuilder().build(
              _sharedArmNames(methods: methods, fields: [1, 2, 2]),
            ),
          ),
      ];
      expect(classes.first, containsAll(['SignUpInput', 'BbSignUpInput']));
      expect(classes.first, classes.last);
    });

    test('keep the short name by smallest origin, in any spec order', () {
      // `bb` and `zz` declare one union, `cc` another. The union with the
      // smallest origin (`bb.setState`) keeps the short names in every
      // order, whatever its class is named after.
      const orders = [
        ['bb', 'cc', 'zz'],
        ['bb', 'zz', 'cc'],
        ['cc', 'bb', 'zz'],
        ['cc', 'zz', 'bb'],
        ['zz', 'bb', 'cc'],
        ['zz', 'cc', 'bb'],
      ];
      final classes = [
        for (final order in orders)
          _classes(
            CodegenModelBuilder().build(
              _sharedArmNames(
                methods: [for (final ns in order) '$ns.setState'],
                fields: [for (final ns in order) ns == 'cc' ? 1 : 2],
              ),
            ),
          ),
      ];
      expect(classes.first, containsAll(['SignUpInput', 'CcSignUpInput']));
      for (final c in classes) {
        expect(c, classes.first);
      }
    });

    test('of a \$ref union never take an inline twin\'s prefix', () {
      // `zz.setState` declares the same union inline as the `ZInput` schema,
      // so it deduplicates into it. A `schema:` origin ranks before every
      // method origin, so `ZInput` keeps the short names and `bb`'s union
      // takes its prefix.
      final zInput = DiscriminatedUnionRef(
        discriminant: 'action',
        variants: [
          const UnionVariant(
            discriminantValue: 'signUp',
            properties: {
              'f0': PrimitiveRef('String'),
              'f1': PrimitiveRef('String'),
            },
            required: {'f0', 'f1'},
          ),
          const UnionVariant(
            discriminantValue: 'signOut',
            properties: {},
            required: {},
          ),
        ],
      );
      for (final reversed in [false, true]) {
        final classes = _classes(
          CodegenModelBuilder().build(
            _sharedArmNames(
              reversed: reversed,
              methods: const ['bb.setState', 'zz.setState'],
              fields: const [1, 2],
              schemas: {'ZInput': zInput},
            ),
          ),
        );
        expect(
          classes,
          containsAll([
            'SignUpInput',
            'SignOutInput',
            'BbSignUpInput',
            'BbSignOutInput',
          ]),
        );
        expect(classes, isNot(contains('ZzSignUpInput')));
        expect(classes, isNot(contains('ZInputSignUp')));
      }
      // When a smaller schema (`AInput`) keeps the short names, `ZInput`'s
      // arms are named after it, never after `zz`, its inline twin.
      final aInput = DiscriminatedUnionRef(
        discriminant: 'action',
        variants: [
          UnionVariant(
            discriminantValue: 'signUp',
            properties: {
              for (var f = 0; f < 3; f++) 'f$f': const PrimitiveRef('String'),
            },
            required: {for (var f = 0; f < 3; f++) 'f$f'},
          ),
          const UnionVariant(
            discriminantValue: 'signOut',
            properties: {},
            required: {},
          ),
        ],
      );
      final classes = _classes(
        CodegenModelBuilder().build(
          _sharedArmNames(
            methods: const ['bb.setState', 'zz.setState'],
            fields: const [1, 2],
            schemas: {'ZInput': zInput, 'AInput': aInput},
          ),
        ),
      );
      expect(
        classes,
        containsAll(['SignUpInput', 'ZInputSignUp', 'BbSignUpInput']),
      );
      expect(classes, isNot(contains('ZzSignUpInput')));
    });

    test('of a named schema win the short name over a method origin', () {
      // `aa.setState#param:input` sorts before `schema:ZInput` as a string,
      // but a `schema:` origin ranks first, so declaring the union as a
      // named schema pins its arms' short names.
      final zInput = DiscriminatedUnionRef(
        discriminant: 'action',
        variants: [
          const UnionVariant(
            discriminantValue: 'signUp',
            properties: {
              'f0': PrimitiveRef('String'),
              'f1': PrimitiveRef('String'),
            },
            required: {'f0', 'f1'},
          ),
          const UnionVariant(
            discriminantValue: 'signOut',
            properties: {},
            required: {},
          ),
        ],
      );
      final out = const DartCodeGenerator().generate(
        CodegenModelBuilder().build(
          _sharedArmNames(
            methods: const ['aa.setState'],
            fields: const [1],
            schemas: {'ZInput': zInput},
          ),
        ),
      );
      expect(out, contains('class SignUpInput extends ZInput {'));
      expect(out, contains('class AaSignUpInput extends AaSetStateInput {'));
    });

    test('throws with --fail-on-collision', () {
      expect(
        () =>
            CodegenModelBuilder(failOnCollision: true).build(_sharedArmNames()),
        throwsA(
          isA<NamingConflictException>().having(
            (e) => e.message,
            'message',
            contains('SignUpInput -> CognitoSignUpInput'),
          ),
        ),
      );
    });
  });
}
