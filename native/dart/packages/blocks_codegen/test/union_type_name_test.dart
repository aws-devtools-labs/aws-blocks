import 'dart:convert';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:test/test.dart';

/// The `oneOf` of an action union, named [typeName] when it is non-null.
Map<String, dynamic> _actionUnion(String? typeName) => {
  'oneOf': [
    for (final action in ['signIn', 'signOut'])
      {
        'type': 'object',
        'properties': {
          'action': {
            'type': 'string',
            'enum': [action],
          },
        },
        'required': ['action'],
      },
  ],
  'x-blocks-type-name': ?typeName,
};

/// A `setState` method in each of [namespaces], all taking one action union,
/// plus [schemas] as components.
String _spec(
  List<String> namespaces, {
  String? typeName = 'ActionInput',
  Map<String, dynamic> schemas = const {},
}) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    for (final ns in namespaces)
      {
        'name': '$ns.setState',
        'params': [
          {'name': 'input', 'required': true, 'schema': _actionUnion(typeName)},
        ],
        'result': {
          'name': 'SetStateResult',
          'schema': {'type': 'boolean'},
        },
      },
  ],
  'components': {'schemas': schemas},
});

CodegenModel _build(String spec) =>
    CodegenModelBuilder().build(const OpenRpcParser().parse(spec));

String _generate(String spec) =>
    const DartCodeGenerator().generate(_build(spec));

void main() {
  group('x-blocks-type-name on a param union', () {
    test('names the union, whatever namespace comes first', () {
      for (final namespaces in [
        ['zetaApi', 'alphaApi'],
        ['alphaApi', 'zetaApi'],
      ]) {
        final source = _generate(_spec(namespaces));
        expect(source, contains('sealed class ActionInput {'));
        expect(source, contains('class SignInInput extends ActionInput {'));
        expect(source, contains('required ActionInput input'));
      }
    });

    test('keeps the old name as a deprecated alias', () {
      final source = _generate(_spec(['zetaApi', 'alphaApi']));
      expect(
        source,
        contains(
          "@Deprecated('Use ActionInput')\n"
          'typedef ZetaApiSetStateInput = ActionInput;',
        ),
      );
      expect(source, isNot(contains('typedef AlphaApiSetStateInput')));
    });

    test('without the key, the union is named as before', () {
      final model = _build(_spec(['alphaApi'], typeName: null));
      expect(model.types.keys, contains('AlphaApiSetStateInput'));
      expect(model.deprecatedAliases, isEmpty);
    });

    test('falls back to the old name when another type has the name', () {
      final model = _build(
        _spec(
          ['alphaApi'],
          schemas: {
            'ActionInput': {
              'type': 'object',
              'properties': {
                'id': {'type': 'string'},
              },
              'required': ['id'],
            },
          },
        ),
      );
      final union = model.types['AlphaApiSetStateInput'];
      expect(union, isA<SealedClassType>());
      expect(model.types['ActionInput'], isA<RecordType>());
      expect(model.deprecatedAliases, isEmpty);
      expect(
        model.warnings,
        contains(contains('union ActionInput is generated as')),
      );
    });

    test('falls back when an arm of another union has the name', () {
      final spec = jsonDecode(_spec(['alphaApi'])) as Map<String, dynamic>;
      (spec['methods'] as List).add({
        'name': 'alphaApi.other',
        'params': [
          {
            'name': 'input',
            'required': true,
            'schema': {
              'oneOf': [
                for (final kind in ['action', 'other'])
                  {
                    'type': 'object',
                    'properties': {
                      'kind': {
                        'type': 'string',
                        'enum': [kind],
                      },
                    },
                    'required': ['kind'],
                  },
              ],
            },
          },
        ],
        'result': {
          'name': 'OtherResult',
          'schema': {'type': 'boolean'},
        },
      });
      final model = _build(jsonEncode(spec));
      expect(model.types['AlphaApiSetStateInput'], isA<SealedClassType>());
      expect(model.deprecatedAliases, isEmpty);
    });

    test('drops a deprecated alias named like an OIDC provider enum', () {
      // `auth.apiGetClient(provider)` used to name its input
      // `AuthApiGetClientProvider`, which `auth.getClient`'s provider enum
      // now has, so the alias would declare that name twice.
      final spec = jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'auth.apiGetClient',
            'params': [
              {
                'name': 'provider',
                'required': true,
                'schema': _actionUnion('ActionInput'),
              },
            ],
            'result': {
              'name': 'ApiGetClientResult',
              'schema': {'type': 'boolean'},
            },
          },
          {
            'name': 'auth.getClient',
            'params': <Object>[],
            'result': {
              'name': 'GetClientResult',
              'schema': {
                'x-blocks-transferable': 'oidc/client',
                'x-blocks-type-args': [
                  {
                    'type': 'string',
                    'enum': ['google'],
                  },
                ],
              },
            },
          },
        ],
      });
      final model = _build(spec);
      expect(model.deprecatedAliases, isEmpty);
      final source = const DartCodeGenerator().generate(model);
      expect(source, contains('enum AuthApiGetClientProvider'));
      expect(source, isNot(contains('typedef AuthApiGetClientProvider')));
    });
  });
}
