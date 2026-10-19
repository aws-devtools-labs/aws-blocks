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

    test(
      'hydrates a nullable bound transferable to its optional concrete type',
      () {
        final output = gen.generate(
          const CodegenModel(
            title: 'test',
            version: '1.0',
            namespaces: [
              Namespace(
                name: 'api',
                operations: [
                  Operation(
                    name: 'maybeChannel',
                    fullName: 'api.maybeChannel',
                    params: [],
                    result: NullableType(
                      TransferableType(
                        blocksType: 'realtime/channel',
                        typeArgs: [],
                      ),
                    ),
                  ),
                ],
              ),
            ],
            types: {},
          ),
        );
        expect(
          output,
          contains('Future<RealtimeChannel<dynamic>?> maybeChannel()'),
        );
        expect(
          output,
          contains(
            'result == null ? null : RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => json)',
          ),
        );
      },
    );

    test('hydrates a nullable bound file handle via its fromJson', () {
      final output = gen.generate(
        const CodegenModel(
          title: 'test',
          version: '1.0',
          namespaces: [
            Namespace(
              name: 'api',
              operations: [
                Operation(
                  name: 'maybeFile',
                  fullName: 'api.maybeFile',
                  params: [],
                  result: NullableType(
                    TransferableType(blocksType: 'file-bucket/download'),
                  ),
                ),
              ],
            ),
          ],
          types: {},
        ),
      );
      expect(output, contains('Future<FileDownloadHandle?> maybeFile()'));
      expect(
        output,
        contains(
          'result == null ? null : FileDownloadHandle.fromJson(result as Map<String, dynamic>)',
        ),
      );
    });

    test('hydrates a nullable bound transferable with a type argument', () {
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.op',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'oneOf': [
                    {
                      'x-blocks-transferable': 'realtime/channel',
                      'x-blocks-type-args': [
                        {r'$ref': '#/components/schemas/Telemetry'},
                      ],
                    },
                    {'type': 'null'},
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
                  'v': {'type': 'number'},
                },
                'required': ['v'],
              },
            },
          },
        }),
      );
      expect(output, contains('class Telemetry'));
      expect(output, contains('Future<RealtimeChannel<Telemetry>?> op()'));
      expect(
        output,
        contains(
          'result == null ? null : RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => Telemetry.fromJson(json))',
        ),
      );
    });

    test('a nullable object channel type argument hydrates its object', () {
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.ch',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [
                    {
                      'oneOf': [
                        {r'$ref': '#/components/schemas/Msg'},
                        {'type': 'null'},
                      ],
                    },
                  ],
                },
              },
            },
          ],
          'components': {
            'schemas': {
              'Msg': {
                'type': 'object',
                'properties': {
                  'x': {'type': 'number'},
                },
                'required': ['x'],
              },
            },
          },
        }),
      );
      expect(output, contains('Future<RealtimeChannel<Msg?>> ch()'));
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => Msg.fromJson(json))',
        ),
      );
    });

    test('a dynamic channel type argument passes the value through', () {
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.nullableDyn',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'oneOf': [
                    {
                      'x-blocks-transferable': 'realtime/channel',
                      'x-blocks-type-args': [<String, dynamic>{}],
                    },
                    {'type': 'null'},
                  ],
                },
              },
            },
            {
              'name': 'api.directDyn',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'S',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [<String, dynamic>{}],
                },
              },
            },
          ],
        }),
      );
      expect(output, isNot(contains('dynamic.fromJson')));
      expect(
        output,
        contains(
          'result == null ? null : RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => json)',
        ),
      );
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => json)',
        ),
      );
    });

    test('a concrete non-object channel message type stays raw', () {
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.nullableStr',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'oneOf': [
                    {
                      'x-blocks-transferable': 'realtime/channel',
                      'x-blocks-type-args': [
                        {'type': 'string'},
                      ],
                    },
                    {'type': 'null'},
                  ],
                },
              },
            },
            {
              'name': 'api.directStr',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'S',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [
                    {'type': 'string'},
                  ],
                },
              },
            },
          ],
        }),
      );
      // Non-hydratable message: no `fromJson` call is emitted for it, and the
      // nullable arm collapses to a bare `return result;` rather than a
      // redundant `result == null ? null : result` throwing ternary.
      expect(output, isNot(contains('fromJson')));
      expect(output, isNot(contains('result == null ? null : result')));
      expect(output, contains('return result;'));
    });

    test('a sealed-union channel message type hydrates via fromJson', () {
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.events',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [
                    {r'$ref': '#/components/schemas/Event'},
                  ],
                },
              },
            },
          ],
          'components': {
            'schemas': {
              'Event': {
                'oneOf': [
                  {
                    'type': 'object',
                    'properties': {
                      'kind': {
                        'type': 'string',
                        'enum': ['added'],
                      },
                      'id': {'type': 'string'},
                    },
                    'required': ['kind', 'id'],
                  },
                  {
                    'type': 'object',
                    'properties': {
                      'kind': {
                        'type': 'string',
                        'enum': ['removed'],
                      },
                      'id': {'type': 'string'},
                    },
                    'required': ['kind', 'id'],
                  },
                ],
              },
            },
          },
        }),
      );
      // The sealed union is a decodable object, so the channel hydrates it.
      expect(output, contains('sealed class Event'));
      expect(output, contains('Future<RealtimeChannel<Event>> events()'));
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => Event.fromJson(json))',
        ),
      );
    });

    test('a Map channel message type hydrates per value', () {
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.metrics',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [
                    {
                      'type': 'object',
                      'additionalProperties': {'type': 'number'},
                    },
                  ],
                },
              },
            },
          ],
        }),
      );
      expect(
        output,
        contains('Future<RealtimeChannel<Map<String, num>>> metrics()'),
      );
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => json.map((k, v) => MapEntry(k, v as num)))',
        ),
      );
    });

    test('a nullable dynamic channel type argument uses an identity decoder', () {
      // `oneOf: [{}, {type: null}]` renders the type arg as `dynamic?`; the
      // structural check must still treat it as the identity/dynamic case.
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.dynQ',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [
                    {
                      'oneOf': [
                        <String, dynamic>{},
                        {'type': 'null'},
                      ],
                    },
                  ],
                },
              },
            },
          ],
        }),
      );
      expect(output, isNot(contains('.fromJson(json)')));
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => json)',
        ),
      );
    });

    test('a non-hydratable bound channel emits the AWSBLOCKS-NATIVE-002 '
        'diagnostic', () {
      final model = _build(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.liveCount',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {
                  'x-blocks-transferable': 'realtime/channel',
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
          'AWSBLOCKS-NATIVE-002: api.liveCount returns realtime/channel with a '
          "non-hydratable message type 'String' on dart; the value is "
          'returned un-hydrated (not supported yet).',
        ),
      );
    });

    test(
      'a nullable non-hydratable bound channel also emits AWSBLOCKS-NATIVE-002',
      () {
        final model = _build(
          jsonEncode({
            'openrpc': '1.3.2',
            'info': {'title': 'test', 'version': '1.0.0'},
            'methods': [
              {
                'name': 'api.liveCount',
                'params': <Map<String, dynamic>>[],
                'result': {
                  'name': 'R',
                  'schema': {
                    'oneOf': [
                      {
                        'x-blocks-transferable': 'realtime/channel',
                        'x-blocks-type-args': [
                          {'type': 'string'},
                        ],
                      },
                      {'type': 'null'},
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
            'AWSBLOCKS-NATIVE-002: api.liveCount returns realtime/channel with a '
            "non-hydratable message type 'String' on dart; the value is "
            'returned un-hydrated (not supported yet).',
          ),
        );
      },
    );

    test(
      'AWSBLOCKS-NATIVE-002 is emitted exactly when the channel body is raw',
      () {
        // Parity across the type-arg matrix (direct and nullable): the diagnostic
        // and the generated raw body are driven by one shared predicate, so an op
        // is diagnosed if and only if its body stays `return result;`.
        Map<String, dynamic> channelOp(
          String name,
          Map<String, dynamic> arg, {
          bool nullable = false,
        }) {
          final channel = {
            'x-blocks-transferable': 'realtime/channel',
            'x-blocks-type-args': [arg],
          };
          return {
            'name': name,
            'params': <Map<String, dynamic>>[],
            'result': {
              'name': 'R_$name',
              'schema': nullable
                  ? {
                      'oneOf': [
                        channel,
                        {'type': 'null'},
                      ],
                    }
                  : channel,
            },
          };
        }

        final model = _build(
          jsonEncode({
            'openrpc': '1.3.2',
            'info': {'title': 'test', 'version': '1.0.0'},
            'methods': [
              channelOp('api.obj', {r'$ref': '#/components/schemas/Msg'}),
              channelOp('api.map', {
                'type': 'object',
                'additionalProperties': {'type': 'number'},
              }),
              channelOp('api.dyn', {
                'oneOf': [
                  <String, dynamic>{},
                  {'type': 'null'},
                ],
              }),
              channelOp('api.str', {'type': 'string'}),
              channelOp('api.list', {
                'type': 'array',
                'items': {'type': 'string'},
              }),
              channelOp('api.enumArg', {r'$ref': '#/components/schemas/Color'}),
              channelOp('api.strNull', {'type': 'string'}, nullable: true),
              channelOp('api.mapNull', {
                'type': 'object',
                'additionalProperties': {'type': 'number'},
              }, nullable: true),
            ],
            'components': {
              'schemas': {
                'Msg': {
                  'type': 'object',
                  'properties': {
                    'x': {'type': 'number'},
                  },
                  'required': ['x'],
                },
                'Color': {
                  'type': 'string',
                  'enum': ['red', 'blue'],
                },
              },
            },
          }),
        );
        final output = _generateModel(model);

        // Ops whose generated body stays raw (`return result;`), keyed by the
        // `_client.call('<fullName>', ...)` that precedes the return.
        final rawOps = <String>{};
        final allOps = <String>{};
        final re = RegExp(
          r"_client\.call\('([^']+)'[^;]*\);\s*return ([^\n]*);",
        );
        for (final m in re.allMatches(output)) {
          final fullName = m.group(1)!;
          allOps.add(fullName);
          if (m.group(2)!.trim() == 'result') rawOps.add(fullName);
        }

        final warnedOps = model.warnings
            .where((w) => w.startsWith('AWSBLOCKS-NATIVE-002:'))
            .map(
              (w) =>
                  w.split(' returns realtime/channel').first.split(': ').last,
            )
            .toSet();

        // The invariant: diagnosed set == raw-body set, both directions.
        expect(warnedOps, equals(rawOps));
        // And it is the primitive/list/enum shapes (direct and nullable), not
        // the object/map/dynamic ones, that stay raw.
        expect(
          rawOps,
          equals({'api.str', 'api.list', 'api.enumArg', 'api.strNull'}),
        );
        expect(allOps.length, 8);
      },
    );
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

    test('a spec schema named UnknownTransferable does not shadow the runtime '
        'fallback type', () {
      // UnknownTransferable is a reserved runtime name, so a same-named spec
      // schema must not be generated as a class that would collide with the
      // fallback reference.
      final output = _generate(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.connectDevice',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'ConnectDeviceResult',
                'schema': {'x-blocks-transferable': 'example-iot/device-link'},
              },
            },
            {
              'name': 'api.getThing',
              'params': <Map<String, dynamic>>[],
              'result': {
                'name': 'R',
                'schema': {r'$ref': '#/components/schemas/UnknownTransferable'},
              },
            },
          ],
          'components': {
            'schemas': {
              'UnknownTransferable': {
                'type': 'object',
                'properties': {
                  'x': {'type': 'string'},
                },
                'required': ['x'],
              },
            },
          },
        }),
      );
      expect(output, isNot(contains('class UnknownTransferable')));
      expect(
        output,
        contains(
          "UnknownTransferable.fromJson(result, "
          "expectedTag: 'example-iot/device-link')",
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
      expect(output, contains('return result;'));
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

  group('knownTransferableTags drift guards', () {
    // tag → expected return type. Keys drift-guard the set; values let the loop
    // assert the concrete type positively (a set tag with no switch arm fails).
    const expectedTypes = {
      'realtime/channel': 'RealtimeChannel<dynamic>',
      'file-bucket/download': 'FileDownloadHandle',
      'file-bucket/upload': 'FileUploadHandle',
      'oidc/client': 'OidcClient',
    };

    test('set equals the exact known-tag map keys', () {
      expect(knownTransferableTags, expectedTypes.keys.toSet());
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
      expect(knownTransferableTags, isNot(contains(tag)));

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
