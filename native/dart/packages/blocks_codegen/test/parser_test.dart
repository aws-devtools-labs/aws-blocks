import 'dart:convert';
import 'package:blocks_codegen/src/parser.dart';
import 'package:blocks_codegen/src/model.dart';
import 'package:test/test.dart';

String _spec(List<Map<String, dynamic>> methods,
    [Map<String, dynamic>? schemas]) {
  return jsonEncode({
    'openrpc': '1.3.2',
    'info': {'title': 'test', 'version': '1.0.0'},
    'methods': methods,
    if (schemas != null) 'components': {'schemas': schemas},
  });
}

void main() {
  const parser = OpenRpcParser();

  group('result name', () {
    test('captures declared result content-descriptor name', () {
      final model = parser.parse(_spec([
        {
          'name': 'api.get',
          'params': [],
          'result': {
            'name': 'Todo',
            'schema': {
              'type': 'object',
              'properties': {
                'title': {'type': 'string'},
                'done': {'type': 'boolean'}
              },
              'required': ['title', 'done']
            }
          }
        },
      ]));
      expect(model.methods[0].resultName, 'Todo');
    });

    test('resultName is null when result has no declared name', () {
      final model = parser.parse(_spec([
        {
          'name': 'api.get',
          'params': [],
          'result': {
            'schema': {'type': 'string'}
          }
        },
      ]));
      expect(model.methods[0].resultName, isNull);
    });
  });

  group('primitives', () {
    test('parses string, number, boolean, integer', () {
      final model = parser.parse(_spec([
        {
          'name': 'test.fn',
          'params': [
            {
              'name': 'a',
              'required': true,
              'schema': {'type': 'string'}
            },
            {
              'name': 'b',
              'required': false,
              'schema': {'type': 'number'}
            },
            {
              'name': 'c',
              'required': true,
              'schema': {'type': 'boolean'}
            },
            {
              'name': 'd',
              'required': true,
              'schema': {'type': 'integer'}
            },
          ],
          'result': {
            'name': 'R',
            'schema': {'type': 'string'}
          }
        },
      ]));
      final params = model.methods[0].params;
      expect((params[0].schema as PrimitiveRef).dartType, 'String');
      expect((params[1].schema as PrimitiveRef).dartType, 'num');
      expect((params[2].schema as PrimitiveRef).dartType, 'bool');
      expect((params[3].schema as PrimitiveRef).dartType, 'int');
    });
  });

  group('\$ref', () {
    test('parses schema reference', () {
      final model = parser.parse(_spec([
        {
          'name': 'get',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {r'$ref': '#/components/schemas/Todo'}
          }
        },
      ], {
        'Todo': {
          'type': 'object',
          'properties': {
            'id': {'type': 'string'}
          },
          'required': ['id']
        }
      }));
      expect(model.methods[0].result, isA<SchemaRefRef>());
      expect((model.methods[0].result as SchemaRefRef).name, 'Todo');
    });
  });

  group('nullable', () {
    test('parses oneOf [T, null] as NullableRef', () {
      final model = parser.parse(_spec([
        {
          'name': 'get',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {
              'oneOf': [
                {'type': 'string'},
                {'type': 'null'}
              ]
            }
          }
        },
      ]));
      final result = model.methods[0].result as NullableRef;
      expect((result.inner as PrimitiveRef).dartType, 'String');
    });
  });

  group('discriminated union', () {
    test('detects shared single-value enum field', () {
      final model = parser.parse(_spec([
        {
          'name': 'set',
          'params': [
            {
              'name': 'input',
              'required': true,
              'schema': {
                'oneOf': [
                  {
                    'type': 'object',
                    'properties': {
                      'action': {
                        'type': 'string',
                        'enum': ['a']
                      },
                      'x': {'type': 'string'}
                    },
                    'required': ['action', 'x']
                  },
                  {
                    'type': 'object',
                    'properties': {
                      'action': {
                        'type': 'string',
                        'enum': ['b']
                      },
                      'y': {'type': 'number'}
                    },
                    'required': ['action', 'y']
                  },
                ]
              }
            }
          ],
          'result': {
            'name': 'R',
            'schema': {'type': 'null'}
          }
        },
      ]));
      final param = model.methods[0].params[0].schema as DiscriminatedUnionRef;
      expect(param.discriminant, 'action');
      expect(param.variants.length, 2);
      expect(param.variants[0].discriminantValue, 'a');
      expect(param.variants[1].discriminantValue, 'b');
    });
  });

  group('transferable', () {
    test('parses x-blocks-transferable', () {
      final model = parser.parse(_spec([
        {
          'name': 'get',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {
              'x-blocks-transferable': 'realtime/channel',
              'x-blocks-type-args': [
                {
                  'type': 'object',
                  'properties': {
                    'x': {'type': 'number'}
                  },
                  'required': ['x']
                }
              ],
            }
          }
        },
      ]));
      final result = model.methods[0].result as TransferableRef;
      expect(result.blocksType, 'realtime/channel');
      expect(result.typeArgs.length, 1);
      expect(result.typeArgs[0], isA<InlineObjectRef>());
    });
  });

  group('arrays and enums', () {
    test('parses array type', () {
      final model = parser.parse(_spec([
        {
          'name': 'list',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {
              'type': 'array',
              'items': {'type': 'string'}
            }
          }
        },
      ]));
      final result = model.methods[0].result as ArrayRef;
      expect((result.items as PrimitiveRef).dartType, 'String');
    });

    test('parses enum', () {
      final model = parser.parse(_spec([
        {
          'name': 'fn',
          'params': [
            {
              'name': 'sort',
              'required': false,
              'schema': {
                'type': 'string',
                'enum': ['a', 'b', 'c']
              }
            }
          ],
          'result': {
            'name': 'R',
            'schema': {'type': 'null'}
          }
        },
      ]));
      final param = model.methods[0].params[0].schema as UnionLiteralRef;
      expect(param.values, ['a', 'b', 'c']);
    });

    test('boolean enum maps to bool, not a Dart enum', () {
      // A boolean discriminator arm (`{"type":"boolean","enum":[true]}`) must
      // stay a `bool`. Treating it as a UnionLiteralRef would emit
      // `enum Foo { true }` — and `true`/`false` are Dart keywords that don't
      // compile. Regression test for the boolean-discriminator codegen bug.
      final model = parser.parse(_spec([
        {
          'name': 'fn',
          'params': [
            {
              'name': 't',
              'required': true,
              'schema': {
                'type': 'boolean',
                'enum': [true]
              }
            },
            {
              'name': 'f',
              'required': true,
              'schema': {
                'type': 'boolean',
                'enum': [false]
              }
            },
          ],
          'result': {
            'name': 'R',
            'schema': {'type': 'null'}
          }
        },
      ]));
      final params = model.methods[0].params;
      expect(params[0].schema, isA<PrimitiveRef>());
      expect((params[0].schema as PrimitiveRef).dartType, 'bool');
      expect((params[1].schema as PrimitiveRef).dartType, 'bool');
    });

    test('numeric enum maps to its primitive, not a Dart enum', () {
      // Same rule for integer/number: an `enum` value-restriction on a numeric
      // primitive is not a distinct type. Keep it as int/num.
      final model = parser.parse(_spec([
        {
          'name': 'fn',
          'params': [
            {
              'name': 'i',
              'required': true,
              'schema': {
                'type': 'integer',
                'enum': [1, 2]
              }
            },
            {
              'name': 'n',
              'required': true,
              'schema': {
                'type': 'number',
                'enum': [1.5]
              }
            },
          ],
          'result': {
            'name': 'R',
            'schema': {'type': 'null'}
          }
        },
      ]));
      final params = model.methods[0].params;
      expect((params[0].schema as PrimitiveRef).dartType, 'int');
      expect((params[1].schema as PrimitiveRef).dartType, 'num');
    });

    test('parses array with missing items as dynamic list', () {
      final model = parser.parse(_spec([
        {
          'name': 'list',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {'type': 'array'}
          }
        },
      ]));
      final result = model.methods[0].result as ArrayRef;
      expect((result.items as PrimitiveRef).dartType, 'dynamic');
    });
  });

  group('tuples', () {
    test('parses prefixItems as TupleRef', () {
      final model = parser.parse(_spec([
        {
          'name': 'api.getCoords',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {
              'type': 'array',
              'prefixItems': [
                {'type': 'number'},
                {'type': 'number'},
                {'type': 'string'},
              ],
            }
          }
        },
      ]));
      final result = model.methods[0].result as TupleRef;
      expect(result.items.length, 3);
      expect((result.items[0] as PrimitiveRef).dartType, 'num');
      expect((result.items[1] as PrimitiveRef).dartType, 'num');
      expect((result.items[2] as PrimitiveRef).dartType, 'String');
    });

    test('single-element tuple collapses to inner type', () {
      final model = parser.parse(_spec([
        {
          'name': 'api.get',
          'params': [],
          'result': {
            'name': 'R',
            'schema': {
              'type': 'array',
              'prefixItems': [
                {'type': 'string'}
              ],
            }
          }
        },
      ]));
      expect(model.methods[0].result, isA<PrimitiveRef>());
      expect((model.methods[0].result as PrimitiveRef).dartType, 'String');
    });
  });
}
