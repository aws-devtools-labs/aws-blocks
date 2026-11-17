import 'dart:convert';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:test/test.dart';

String _generate(String spec) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
);

/// A method whose one parameter is a union with an arm per discriminator value.
String _unionSpec(List<String> values) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.op',
      'params': [
        {
          'name': 'input',
          'required': true,
          'schema': {
            'oneOf': [
              for (final v in values)
                {
                  'type': 'object',
                  'properties': {
                    'kind': {
                      'type': 'string',
                      'enum': [v],
                    },
                    'n': {'type': 'string'},
                  },
                  'required': ['kind'],
                },
            ],
          },
        },
      ],
      'result': {
        'name': 'OpResult',
        'schema': {'type': 'boolean'},
      },
    },
  ],
});

void main() {
  group('union arms', () {
    for (final (a, b) in [('Foo', 'foo'), ('a-b', 'a_b')]) {
      test('discriminator values $a and $b get distinct arm classes', () {
        final source = _generate(_unionSpec([a, b]));
        final arms = RegExp(
          r'^class (\w+) extends ApiOpInput',
          multiLine: true,
        ).allMatches(source).map((m) => m.group(1)).toList();
        expect(arms, hasLength(2));
        expect(arms.toSet(), hasLength(2), reason: 'arms: $arms');
        // Each value decodes through its own arm.
        for (final arm in arms) {
          expect(source, contains('return $arm.fromJson(json);'));
        }
      });
    }
  });
}
