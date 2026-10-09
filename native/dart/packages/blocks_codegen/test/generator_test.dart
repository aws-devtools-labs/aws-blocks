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
      // An `unknown` message can be any JSON value, so the raw payload is
      // passed through (this used to emit `dynamic.fromJson(json)`).
      expect(
        output,
        contains(
          'RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload)',
        ),
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
      // A `Msg?` message can be null, so each payload decodes through
      // `fromJsonValue` with a null guard rather than the map-typed `fromJson`.
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload == null ? null : Msg.fromJson(payload as Map<String, dynamic>))',
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
      // An `unknown` message is handed over as is, whatever JSON it is.
      expect(
        output,
        contains(
          'result == null ? null : RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload)',
        ),
      );
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload)',
        ),
      );
    });

    test('a concrete non-object channel message type hydrates through '
        'fromJsonValue', () {
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
      // A primitive message is decoded per payload by `fromJsonValue`, which
      // takes the raw payload (not only a map), so the channel is hydrated,
      // directly and behind the nullable result's null guard. The value is
      // never returned as the raw descriptor.
      expect(
        output,
        contains('Future<RealtimeChannel<String>?> nullableStr()'),
      );
      expect(output, contains('Future<RealtimeChannel<String>> directStr()'));
      expect(
        output,
        contains(
          'return result == null ? null : RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload as String)',
        ),
      );
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload as String)',
        ),
      );
      expect(output, isNot(contains('result == null ? null : result')));
      expect(output, isNot(contains('return result;')));
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
          'return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => (payload as Map<String, dynamic>).map((k1, v1) => MapEntry(k1, v1 as num)))',
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
      expect(output, contains('Future<RealtimeChannel<dynamic>> dynQ()'));
      expect(
        output,
        contains(
          'return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload as dynamic)',
        ),
      );
    });

    test('a primitive-message bound channel emits no diagnostic and is '
        'hydrated', () {
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
      // Every message type hydrates (see `fromJsonValue`), so there is nothing
      // to warn about: no `AWSBLOCKS-NATIVE-002`, and no warning at all.
      expect(model.warnings, isEmpty);
      expect(
        _generateModel(model),
        contains(
          'return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload as String)',
        ),
      );
    });

    test('a nullable primitive-message bound channel emits no diagnostic and is '
        'hydrated', () {
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
      expect(model.warnings, isEmpty);
      expect(
        _generateModel(model),
        contains(
          'return result == null ? null : RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => payload as String)',
        ),
      );
    });

    test('every bound channel body is hydrated, and none is diagnosed', () {
      // Across the type-arg matrix (direct and nullable), no channel body
      // stays the raw descriptor (`return result;`): an object message
      // decodes through `fromJson`, any other (a map, `unknown`, primitive,
      // list or enum) through `fromJsonValue`. So `AWSBLOCKS-NATIVE-002`
      // (raw channel) is never emitted.
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
      final re = RegExp(r"_client\.call\('([^']+)'[^;]*\);\s*return ([^\n]*);");
      for (final m in re.allMatches(output)) {
        final fullName = m.group(1)!;
        allOps.add(fullName);
        if (m.group(2)!.trim() == 'result') rawOps.add(fullName);
      }

      final warnedOps = model.warnings
          .where((w) => w.startsWith('AWSBLOCKS-NATIVE-002:'))
          .map(
            (w) => w.split(' returns realtime/channel').first.split(': ').last,
          )
          .toSet();

      expect(warnedOps, isEmpty);
      expect(rawOps, isEmpty);
      expect(model.warnings, isEmpty);
      expect(allOps.length, 8);
      // The primitive, list and enum shapes main's Map-only runtime left raw.
      for (final decode in [
        '(payload) => payload as String)',
        '(payload) => (payload as List<dynamic>).cast<String>())',
        '(payload) => Color.fromJson(payload as String))',
      ]) {
        expect(output, contains(decode));
      }
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
      expect(
        output,
        contains(
          r'      [coords.$1, coords.$2],'
          '\n',
        ),
      );
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
      expect(output, contains('Future<dynamic> get'));
      expect(output, isNot(contains('dynamic?')));
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

  group('nullable unknown stays dynamic (already nullable)', () {
    // `dynamic?` trips `unnecessary_question_mark`, so a nullable or optional
    // `unknown` is emitted as plain `dynamic`, in collections too.
    const unknown = {'type': 'unknown'};
    const nullableUnknown = {
      'oneOf': [
        {'type': 'unknown'},
        {'type': 'null'},
      ],
    };
    final output = _generateModel(
      _build(
        jsonEncode({
          'openrpc': '1.3.2',
          'info': {'title': 'test', 'version': '1.0.0'},
          'methods': [
            {
              'name': 'api.collect',
              'params': [
                {'name': 'maybe', 'required': true, 'schema': nullableUnknown},
                {
                  'name': 'holes',
                  'required': true,
                  'schema': {'type': 'array', 'items': nullableUnknown},
                },
                {
                  'name': 'sparse',
                  'required': true,
                  'schema': {
                    'type': 'object',
                    'additionalProperties': nullableUnknown,
                  },
                },
                {'name': 'extra', 'required': false, 'schema': unknown},
              ],
              'result': {
                'name': 'R',
                'schema': {r'$ref': '#/components/schemas/Entry'},
              },
            },
          ],
          'components': {
            'schemas': {
              'Entry': {
                'type': 'object',
                'properties': {
                  'optionalPayload': unknown,
                  'nullablePayload': nullableUnknown,
                },
                'required': ['nullablePayload'],
              },
            },
          },
        }),
      ),
    );

    test('never emits dynamic?', () {
      expect(output, isNot(contains('dynamic?')));
    });

    test('fields', () {
      expect(output, contains('final dynamic optionalPayload;'));
      expect(output, contains('final dynamic nullablePayload;'));
      expect(output, contains("json['optionalPayload'] as dynamic,"));
      expect(output, contains("json['nullablePayload'] as dynamic,"));
    });

    test('parameters and collections', () {
      expect(output, contains('required dynamic maybe'));
      expect(output, contains('required List<dynamic> holes'));
      expect(output, contains('required Map<String, dynamic> sparse'));
      expect(output, contains('dynamic extra}'));
    });
  });

  group('constraint checks on nullable fields', () {
    // A public field can't be promoted by a null check in the constructor
    // body, so `x == null || x.length >= 2` doesn't compile. Checks on a
    // nullable field bind a local first, as Swift's `if let` and Kotlin's
    // `?.let` do.
    final output = _generate(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'api.create',
            'params': [
              {
                'name': 'input',
                'required': true,
                'schema': {
                  'type': 'object',
                  'properties': {
                    'name': {'type': 'string', 'minLength': 1},
                    'nickname': {
                      'type': 'string',
                      'minLength': 2,
                      'maxLength': 30,
                      'pattern': r'^[a-z]+$',
                    },
                    'score': {'type': 'number', 'minimum': 0, 'maximum': 1},
                    'step': {
                      'type': 'integer',
                      'exclusiveMinimum': 0,
                      'exclusiveMaximum': 10,
                      'multipleOf': 2,
                    },
                    'tags': {
                      'type': 'array',
                      'items': {'type': 'string'},
                      'minItems': 1,
                      'maxItems': 5,
                    },
                    'class': {'type': 'string', 'minLength': 1},
                    'motto': {
                      'oneOf': [
                        {'type': 'string', 'minLength': 3},
                        {'type': 'null'},
                      ],
                    },
                  },
                  'required': ['name', 'motto', 'class'],
                },
              },
            ],
            'result': {
              'name': 'R',
              'schema': {'type': 'boolean'},
            },
          },
        ],
      }),
    );

    test('never null-checks a field inline', () {
      expect(output, isNot(contains('== null ||')));
    });

    test('a required non-null field is checked directly', () {
      expect(
        output,
        contains(
          "    if (!(name.length >= 1)) throw ArgumentError('name must be at least 1 characters');",
        ),
      );
    });

    test('an optional field binds a non-null local for every check', () {
      expect(
        output,
        contains(
          '    if (nickname case final nickname?) {\n'
          "      if (!(nickname.length >= 2)) throw ArgumentError('nickname must be at least 2 characters');\n"
          "      if (!(nickname.length <= 30)) throw ArgumentError('nickname must be at most 30 characters');\n"
          "      if (!(RegExp(r'^[a-z]+\$').hasMatch(nickname))) throw ArgumentError('nickname must match pattern');\n"
          '    }\n',
        ),
      );
      expect(output, contains('    if (score case final score?) {\n'));
      expect(output, contains('if (!(score >= 0)) throw'));
      expect(output, contains('if (!(score <= 1)) throw'));
      expect(output, contains('    if (step case final step?) {\n'));
      expect(output, contains('if (!(step > 0)) throw'));
      expect(output, contains('if (!(step < 10)) throw'));
      expect(output, contains('if (!(step % 2 == 0)) throw'));
      expect(output, contains('    if (tags case final tags?) {\n'));
      expect(output, contains('if (!(tags.length >= 1)) throw'));
      expect(output, contains('if (!(tags.length <= 5)) throw'));
    });

    test('a keyword-escaped field name is escaped in the message', () {
      expect(
        output,
        contains(
          r"    if (!(class$.length >= 1)) throw ArgumentError('class\$ must be at least 1 characters');",
        ),
      );
    });

    test('a required but nullable field binds a local too', () {
      expect(output, contains('  final String? motto;'));
      expect(output, contains('    required this.motto,'));
      expect(
        output,
        contains(
          '    if (motto case final motto?) {\n'
          "      if (!(motto.length >= 3)) throw ArgumentError('motto must be at least 3 characters');\n"
          '    }\n',
        ),
      );
    });
  });

  group('realtime channels are hydrated and typed wherever they appear', () {
    // A record field used to pass the raw descriptor (`dynamic`) where a
    // `RealtimeChannel<…>` was expected, and a channel whose message type
    // isn't an object generated `List<String>.fromJson(json)`.
    Map<String, dynamic> channelOf(Map<String, dynamic> message) => {
      'x-blocks-transferable': 'realtime/channel',
      'x-blocks-type-args': [message],
    };
    const textMessage = {
      'type': 'object',
      'properties': {
        'text': {'type': 'string'},
      },
      'required': ['text'],
    };
    const stringList = {
      'type': 'array',
      'items': {'type': 'string'},
    };
    final output = _generate(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'api.session',
            'params': <Map<String, dynamic>>[],
            'result': {
              'name': 'SessionResult',
              'schema': {
                'type': 'object',
                'properties': {
                  'chat': channelOf(textMessage),
                  'tags': channelOf(stringList),
                  'counts': channelOf({
                    'type': 'array',
                    'items': {'type': 'integer'},
                  }),
                  'ticks': channelOf({'type': 'integer'}),
                  'anything': channelOf({'type': 'unknown'}),
                  'maybe': channelOf({
                    'type': 'object',
                    'properties': {
                      'note': {'type': 'string'},
                    },
                    'required': ['note'],
                  }),
                  'nullable': {
                    'oneOf': [
                      channelOf(stringList),
                      {'type': 'null'},
                    ],
                  },
                  'file': {'x-blocks-transferable': 'file-bucket/download'},
                  'upload': {'x-blocks-transferable': 'file-bucket/upload'},
                },
                'required': [
                  'chat',
                  'tags',
                  'counts',
                  'ticks',
                  'anything',
                  'nullable',
                  'file',
                  'upload',
                ],
              },
            },
          },
          {
            'name': 'api.tagChannel',
            'params': <Map<String, dynamic>>[],
            'result': {'name': 'TagChannel', 'schema': channelOf(stringList)},
          },
          {
            'name': 'api.maybeTagChannel',
            'params': <Map<String, dynamic>>[],
            'result': {
              'name': 'MaybeTagChannel',
              'schema': {
                'oneOf': [
                  channelOf(stringList),
                  {'type': 'null'},
                ],
              },
            },
          },
        ],
      }),
    );

    test('fields keep their channel types', () {
      expect(
        output,
        contains('  final RealtimeChannel<SessionResultChatMessage> chat;'),
      );
      expect(output, contains('  final RealtimeChannel<List<String>> tags;'));
      expect(output, contains('  final RealtimeChannel<List<int>> counts;'));
      expect(output, contains('  final RealtimeChannel<int> ticks;'));
      expect(output, contains('  final RealtimeChannel<dynamic> anything;'));
      expect(
        output,
        contains('  final RealtimeChannel<SessionResultMaybeMessage>? maybe;'),
      );
      expect(
        output,
        contains('  final RealtimeChannel<List<String>>? nullable;'),
      );
    });

    test('a field with an object message uses fromJson', () {
      expect(
        output,
        contains(
          "      chat: RealtimeChannel.fromJson(json['chat'] as Map<String, dynamic>, (json) => SessionResultChatMessage.fromJson(json)),",
        ),
      );
    });

    test('a field with any other message decodes the payload value', () {
      expect(
        output,
        contains(
          "      tags: RealtimeChannel.fromJsonValue(json['tags'] as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<String>()),",
        ),
      );
      expect(
        output,
        contains(
          "      counts: RealtimeChannel.fromJsonValue(json['counts'] as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<int>()),",
        ),
      );
      expect(
        output,
        contains(
          "      ticks: RealtimeChannel.fromJsonValue(json['ticks'] as Map<String, dynamic>, (payload) => (payload as num).toInt()),",
        ),
      );
      expect(
        output,
        contains(
          "      anything: RealtimeChannel.fromJsonValue(json['anything'] as Map<String, dynamic>, (payload) => payload),",
        ),
      );
    });

    test('optional and nullable fields hydrate only when present', () {
      expect(
        output,
        contains(
          "      maybe: json['maybe'] != null ? RealtimeChannel.fromJson(json['maybe'] as Map<String, dynamic>, (json) => SessionResultMaybeMessage.fromJson(json)) : null,",
        ),
      );
      expect(
        output,
        contains(
          "      nullable: json['nullable'] != null ? RealtimeChannel.fromJsonValue(json['nullable'] as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<String>()) : null,",
        ),
      );
    });

    test('file handle fields are hydrated too', () {
      expect(
        output,
        contains(
          "      file: FileDownloadHandle.fromJson(json['file'] as Map<String, dynamic>),",
        ),
      );
      expect(
        output,
        contains(
          "      upload: FileUploadHandle.fromJson(json['upload'] as Map<String, dynamic>),",
        ),
      );
    });

    test('a direct result with a non-object message decodes the value', () {
      expect(
        output,
        contains('Future<RealtimeChannel<List<String>>> tagChannel()'),
      );
      expect(
        output,
        contains(
          '    return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<String>());',
        ),
      );
      expect(output, isNot(contains('List<String>.fromJson')));
    });

    test('a nullable direct result hydrates only when present', () {
      expect(
        output,
        contains('Future<RealtimeChannel<List<String>>?> maybeTagChannel()'),
      );
      expect(
        output,
        contains(
          '    return result == null ? null : RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<String>());',
        ),
      );
    });
  });

  group('map-valued model fields decode their values', () {
    // A model field `Map<String, Record>` cast each value with `v as Record`,
    // which compiles but throws at runtime: the value is a JSON object.
    const entry = {
      'type': 'object',
      'properties': {
        'code': {'type': 'string'},
      },
      'required': ['code'],
    };
    final output = _generate(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'api.get',
            'params': <Map<String, dynamic>>[],
            'result': {
              'name': 'R',
              'schema': {r'$ref': '#/components/schemas/Holder'},
            },
          },
        ],
        'components': {
          'schemas': {
            'Entry': entry,
            'Level': {
              'type': 'string',
              'enum': ['low', 'high'],
            },
            'Holder': {
              'type': 'object',
              'properties': {
                'byName': {
                  'type': 'object',
                  'additionalProperties': {
                    r'$ref': '#/components/schemas/Entry',
                  },
                },
                'maybeByName': {
                  'type': 'object',
                  'additionalProperties': {
                    r'$ref': '#/components/schemas/Entry',
                  },
                },
                'levels': {
                  'type': 'object',
                  'additionalProperties': {
                    r'$ref': '#/components/schemas/Level',
                  },
                },
                'counts': {
                  'type': 'object',
                  'additionalProperties': {'type': 'integer'},
                },
                'moods': {
                  'type': 'object',
                  'additionalProperties': {
                    'type': 'string',
                    'enum': ['up', 'down'],
                  },
                },
              },
              'required': ['byName', 'levels', 'counts', 'moods'],
            },
          },
        },
      }),
    );

    test('record values decode through fromJson', () {
      expect(
        output,
        contains(
          "      byName: (json['byName'] as Map<String, dynamic>).map((k, v) => MapEntry(k, Entry.fromJson(v as Map<String, dynamic>))),",
        ),
      );
      expect(
        output,
        contains(
          "      maybeByName: (json['maybeByName'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, Entry.fromJson(v as Map<String, dynamic>))),",
        ),
      );
      expect(output, isNot(contains('v as Entry')));
    });

    test('enum values decode through fromJson', () {
      expect(
        output,
        contains(
          "      levels: (json['levels'] as Map<String, dynamic>).map((k, v) => MapEntry(k, Level.fromJson(v as String))),",
        ),
      );
    });

    test('inline enum values decode through fromJson', () {
      expect(
        output,
        matches(
          RegExp(
            r"      moods: \(json\['moods'\] as Map<String, dynamic>\)\.map\(\(k, v\) => MapEntry\(k, \w+\.fromJson\(v as String\)\)\),",
          ),
        ),
      );
    });

    test('primitive values keep the plain cast', () {
      expect(
        output,
        contains(
          "      counts: (json['counts'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as int)),",
        ),
      );
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
