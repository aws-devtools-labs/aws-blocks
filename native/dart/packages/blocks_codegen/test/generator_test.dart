import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

void main() {
  const gen = DartCodeGenerator();

  group('basic generation', () {
    test('generates Blocks class with namespace accessors', () {
      final output = gen.generate(
        CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [
            Namespace(
              name: 'api',
              operations: [
                Operation(
                  name: 'greet',
                  fullName: 'api.greet',
                  params: [
                    OperationParam(
                      name: 'name',
                      type: const PrimitiveType('String'),
                      isRequired: true,
                    ),
                  ],
                  result: const PrimitiveType('String'),
                ),
              ],
            ),
          ],
          types: {},
        ),
      );
      expect(output, contains('class Blocks {'));
      expect(output, contains('late final ApiApi api;'));
      expect(output, contains("Blocks({required String baseUrl"));
      expect(output, contains("_client.call('api.greet'"));
    });
  });

  group('sealed class generation', () {
    test('generates sealed class with fromJson switch', () {
      final output = gen.generate(
        CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [],
          types: {
            'Input': SealedClassType(
              name: 'Input',
              discriminant: 'action',
              variants: [
                SealedVariant(
                  discriminantValue: 'a',
                  className: 'AInput',
                  fields: [
                    RecordField(
                      name: 'x',
                      type: const PrimitiveType('String'),
                      isRequired: true,
                    ),
                  ],
                ),
                SealedVariant(
                  discriminantValue: 'b',
                  className: 'BInput',
                  fields: [],
                ),
              ],
            ),
          },
        ),
      );
      expect(output, contains('sealed class Input {'));
      expect(output, contains("case 'a': return AInput.fromJson(json);"));
      expect(output, contains("case 'b': return BInput.fromJson(json);"));
      expect(output, contains('class AInput extends Input {'));
      expect(output, contains("'action': 'a',"));
    });
  });

  group('transferable hydration', () {
    test('emits RealtimeChannel.fromJson for realtime/channel', () {
      final output = gen.generate(
        CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [
            Namespace(
              name: 'api',
              operations: [
                Operation(
                  name: 'getChannel',
                  fullName: 'api.getChannel',
                  params: [],
                  result: TransferableType(
                    blocksType: 'realtime/channel',
                    typeArgs: [const PrimitiveType('dynamic')],
                  ),
                ),
              ],
            ),
          ],
          types: {},
        ),
      );
      expect(output, contains('Future<RealtimeChannel<dynamic>> getChannel()'));
      expect(
        output,
        contains('RealtimeChannel.fromJson(result as Map<String, dynamic>'),
      );
    });

    test('emits FileDownloadHandle.fromJson for file-bucket/download', () {
      final output = gen.generate(
        CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [
            Namespace(
              name: 'api',
              operations: [
                Operation(
                  name: 'download',
                  fullName: 'api.download',
                  params: [],
                  result: const TransferableType(
                    blocksType: 'file-bucket/download',
                  ),
                ),
              ],
            ),
          ],
          types: {},
        ),
      );
      expect(output, contains('Future<FileDownloadHandle> download()'));
      expect(
        output,
        contains('FileDownloadHandle.fromJson(result as Map<String, dynamic>)'),
      );
    });
  });

  group('tuple generation', () {
    test('emits Dart record type for TupleType', () {
      final output = gen.generate(
        CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [
            Namespace(
              name: 'api',
              operations: [
                Operation(
                  name: 'getCoords',
                  fullName: 'api.getCoords',
                  params: [],
                  result: TupleType([
                    const PrimitiveType('num'),
                    const PrimitiveType('num'),
                    const PrimitiveType('String'),
                  ]),
                ),
              ],
            ),
          ],
          types: {},
        ),
      );
      expect(output, contains('Future<(num, num, String)> getCoords()'));
      expect(output, contains('(result as List<dynamic>)[0] as num'));
      expect(output, contains('(result as List<dynamic>)[1] as num'));
      expect(output, contains('(result as List<dynamic>)[2] as String'));
    });

    test('emits tuple toJson as list for params', () {
      final output = gen.generate(
        CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [
            Namespace(
              name: 'api',
              operations: [
                Operation(
                  name: 'setCoords',
                  fullName: 'api.setCoords',
                  params: [
                    OperationParam(
                      name: 'coords',
                      type: TupleType([
                        const PrimitiveType('num'),
                        const PrimitiveType('String'),
                      ]),
                      isRequired: true,
                    ),
                  ],
                  result: const PrimitiveType('void'),
                ),
              ],
            ),
          ],
          types: {},
        ),
      );
      expect(output, contains(r"'coords': [coords.$1, coords.$2]"));
    });
  });

  group('unbound transferable fallback (Iteration 0)', () {
    // Direct result with an unknown tag + one $ref type-arg, so a payload
    // model is still generated.
    final spec = jsonEncode({
      'openrpc': '1.3.2',
      'info': {'title': 'test', 'version': '1.0.0'},
      'methods': [
        {
          'name': 'api.connectDevice',
          'params': [
            {
              'name': 'deviceId',
              'required': true,
              'schema': {'type': 'string'},
            },
          ],
          'result': {
            'name': 'ConnectDeviceResult',
            'schema': {
              'x-blocks-transferable': 'example-iot/device-link',
              'x-blocks-type-args': [
                {r'$ref': '#/components/schemas/Telemetry'},
              ],
            },
          },
        },
      ],
      'components': {
        'schemas': {
          'Telemetry': {
            'type': 'object',
            'properties': {
              'temperature': {'type': 'number'},
            },
            'required': ['temperature'],
          },
        },
      },
    });

    test('emits UnknownTransferable as the return type', () {
      final output = _generate(spec);
      expect(output, contains('Future<UnknownTransferable> connectDevice('));
    });

    test(
      'emits UnknownTransferable.fromJson with the declared expectedTag',
      () {
        final output = _generate(spec);
        expect(
          output,
          contains(
            'UnknownTransferable.fromJson(result, '
            "expectedTag: 'example-iot/device-link')",
          ),
        );
      },
    );

    test('still emits the type-argument payload model', () {
      expect(_generate(spec), contains('class Telemetry'));
    });

    test('emits the AWSBLOCKS-NATIVE-001 diagnostic naming the type arg', () {
      final model = _build(spec);
      expect(
        model.warnings,
        contains(
          'AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable '
          "'example-iot/device-link' on dart; generated UnknownTransferable "
          'with type argument Telemetry.',
        ),
      );
    });

    test('diagnostic says "no generated type-argument models" for a '
        'type-arg that produces no model', () {
      // A primitive type-arg is a real type argument but yields no standalone
      // model class, so the diagnostic reports the models, not the args.
      final model = _build(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.connectDevice',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'ConnectDeviceResult',
                'schema': {
                  'x-blocks-transferable': 'example-iot/device-link',
                  'x-blocks-type-args': [
                    {'type': 'string'},
                  ],
                },
              },
            },
          ],
        }),
      );
      expect(
        model.warnings,
        contains(
          'AWSBLOCKS-NATIVE-001: api.connectDevice returns unbound transferable '
          "'example-iot/device-link' on dart; generated UnknownTransferable "
          'with no generated type-argument models.',
        ),
      );
    });

    test('diagnostic names the type-arg model after a collision rename', () {
      // Two same-named methods in different namespaces with differently-shaped
      // inline type-args both synthesize `GetResultMessage`; collision
      // resolution renames one to `GetResultMessage2`. The diagnostic must name
      // the post-rename model, so it is formatted after that pass.
      final model = _build(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.get',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'GetResult',
                'schema': {
                  'x-blocks-transferable': 'example-iot/device-link',
                  'x-blocks-type-args': [
                    {
                      'type': 'object',
                      'properties': {
                        'a': {'type': 'string'},
                      },
                      'required': ['a'],
                    },
                  ],
                },
              },
            },
            {
              'name': 'other.get',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'GetResult',
                'schema': {
                  'x-blocks-transferable': 'example-iot/device-link',
                  'x-blocks-type-args': [
                    {
                      'type': 'object',
                      'properties': {
                        'b': {'type': 'integer'},
                      },
                      'required': ['b'],
                    },
                  ],
                },
              },
            },
          ],
        }),
      );
      expect(
        model.warnings,
        contains(
          'AWSBLOCKS-NATIVE-001: other.get returns unbound transferable '
          "'example-iot/device-link' on dart; generated UnknownTransferable "
          'with type argument GetResultMessage2.',
        ),
      );
    });
  });

  group('unbound transferable is direct-results-only (out-of-scope shapes)', () {
    // Out of scope (doc): a nested/list/nullable transferable stays `dynamic`,
    // not UnknownTransferable, with no diagnostic. Fails against an un-gated arm.
    String resultSpec(Map<String, dynamic> resultSchema) => jsonEncode({
      'openrpc': '1.3.2',
      'info': {'title': 'test', 'version': '1.0.0'},
      'methods': [
        {
          'name': 'api.get',
          'params': <Map<String, dynamic>>[],
          'result': {'name': 'R', 'schema': resultSchema},
        },
      ],
    });

    const unknownTransferable = {
      'x-blocks-transferable': 'example-iot/device-link',
    };

    test('nested record field stays dynamic', () {
      final model = _build(
        resultSpec({
          'type': 'object',
          'properties': {'link': unknownTransferable},
          'required': ['link'],
        }),
      );
      final output = _generateModel(model);
      expect(output, contains('final dynamic link;'));
      expect(output, isNot(contains('UnknownTransferable')));
      expect(model.warnings, isEmpty);
    });

    test('nullable direct result stays dynamic', () {
      final model = _build(
        resultSpec({
          'oneOf': [
            unknownTransferable,
            {'type': 'null'},
          ],
        }),
      );
      final output = _generateModel(model);
      expect(output, contains('Future<dynamic?> get'));
      expect(output, isNot(contains('UnknownTransferable')));
      expect(model.warnings, isEmpty);
    });

    test('list of transferables stays List<dynamic>', () {
      final model = _build(
        resultSpec({'type': 'array', 'items': unknownTransferable}),
      );
      final output = _generateModel(model);
      expect(output, contains('Future<List<dynamic>> get'));
      expect(output, contains('.cast<dynamic>()'));
      expect(output, isNot(contains('UnknownTransferable')));
      expect(model.warnings, isEmpty);
    });
  });

  group('kKnownTransferableTags drift guards', () {
    // tag → expected return type. Keys drift-guard the set; values let the loop
    // assert the concrete type positively (a set tag with no switch arm fails).
    const expectedTypes = {
      'realtime/channel': 'RealtimeChannel<dynamic>',
      'file-bucket/download': 'FileDownloadHandle',
      'file-bucket/upload': 'FileUploadHandle',
      'oidc/client': 'OidcClient',
    };

    test('set equals the exact known-tag map keys', () {
      expect(kKnownTransferableTags, expectedTypes.keys.toSet());
    });

    expectedTypes.forEach((tag, expectedType) {
      test("'$tag' maps to $expectedType with no diagnostic", () {
        final model = _build(
          jsonEncode({
            'openrpc': '1.3.2',
            'info': {'title': 'test', 'version': '1.0.0'},
            'methods': [
              {
                'name': 'api.get',
                'params': <Map<String, dynamic>>[],
                'result': {
                  'name': 'R',
                  'schema': {'x-blocks-transferable': tag},
                },
              },
            ],
          }),
        );
        final output = _generateModel(model);
        expect(output, contains('Future<$expectedType> get'));
        expect(output, isNot(contains('UnknownTransferable')));
        expect(
          model.warnings.where((w) => w.contains('AWSBLOCKS-NATIVE-001')),
          isEmpty,
        );
      });
    });

    // Locks the gate: a tag outside the set never maps to a concrete type,
    // so a switch arm added without a set entry can't bind silently.
    test('a tag outside the set never maps to a concrete type', () {
      const tag = 'drift-probe/never-registered';
      expect(kKnownTransferableTags, isNot(contains(tag)));

      // Nested position: stays dynamic, not a concrete runtime type.
      final nested = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.get',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'type': 'object',
                  'properties': {
                    'link': {'x-blocks-transferable': tag},
                  },
                  'required': ['link'],
                },
              },
            },
          ],
        }),
      );
      expect(nested, contains('final dynamic link;'));

      // Direct position: the only in-scope fallback — UnknownTransferable,
      // never a concrete handle type.
      final direct = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.get',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {'x-blocks-transferable': tag},
              },
            },
          ],
        }),
      );
      expect(direct, contains('Future<UnknownTransferable> get'));
    });
  });
}

CodegenModel _build(String spec) =>
    CodegenModelBuilder().build(const OpenRpcParser().parse(spec));

String _generateModel(CodegenModel model) =>
    const DartCodeGenerator().generate(model);

String _generate(String spec) => _generateModel(_build(spec));
