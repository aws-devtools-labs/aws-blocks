import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/model.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// An open record is an object schema with `properties` and
// `additionalProperties` (TS `T & Record<string, V>`). Its extra keys sit flat
// beside its own keys on the wire. A model or an operation-scoped object kept
// them in `additionalProperties`, but a union variant dropped them: the `Auth`
// block's `setAuthState` `signUp` action (`{action, username, password}` plus
// the user's attributes) had no field for them, so a Dart app couldn't send
// sign-up attributes. Every open record now keeps its extra keys, a variant
// excluding its discriminator, and a typed key wins over an extra of the same
// name when encoding.

const _string = {'type': 'string'};
const _note = {r'$ref': '#/components/schemas/Note'};
const _oidc = {'x-blocks-transferable': 'oidc/client'};

Map<String, dynamic> _const(String value) => {
  'type': 'string',
  'enum': [value],
};

/// An arm of a union discriminated by `action`.
Map<String, dynamic> _arm(
  String action,
  Map<String, dynamic> properties, {
  Object? additionalProperties,
  List<Map<String, dynamic>>? oneOf,
}) => {
  'type': 'object',
  'properties': {'action': _const(action), ...properties},
  'required': ['action', ...properties.keys],
  'additionalProperties': ?additionalProperties,
  'oneOf': ?oneOf,
};

Map<String, dynamic> _union(List<Map<String, dynamic>> arms) => {'oneOf': arms};

Map<String, dynamic> _param(String name, Map<String, dynamic> schema) => {
  'name': name,
  'required': true,
  'schema': schema,
};

Map<String, dynamic> _method(
  String name, {
  List<Map<String, dynamic>> params = const [],
  Map<String, dynamic> result = const {'type': 'boolean'},
}) => {
  'name': 'api.$name',
  'params': params,
  'result': {'schema': result},
};

String _generate(List<Map<String, dynamic>> methods) {
  final spec = jsonEncode({
    'openrpc': '1.3.2',
    'info': {'title': 'test', 'version': '1.0.0'},
    'methods': methods,
    'components': {
      'schemas': {
        'Note': {
          'type': 'object',
          'properties': {'text': _string},
          'required': ['text'],
        },
      },
    },
  });
  final model = CodegenModelBuilder().build(const OpenRpcParser().parse(spec));
  return const DartCodeGenerator().generate(model);
}

/// The source of the generated class [name], up to its closing brace.
String _classBody(String output, String name) {
  final start = output.indexOf(RegExp('class $name\\b'));
  expect(start, isNot(-1), reason: 'class $name not generated');
  return output.substring(start, output.indexOf('\n}\n', start) + 2);
}

/// The live `Auth` block's `setAuthState` input, trimmed to two actions.
final _authInput = _union([
  _arm('signUp', {
    'username': _string,
    'password': _string,
  }, additionalProperties: _string),
  _arm('signIn', {'username': _string, 'password': _string}),
]);

void main() {
  group('a union variant that is an open record', () {
    late String signUp;
    setUpAll(() {
      final output = _generate([
        _method('setAuthState', params: [_param('input', _authInput)]),
      ]);
      signUp = _classBody(output, 'SignUpInput');
    });

    test('has an additionalProperties field, empty by default', () {
      expect(
        signUp,
        contains('  final Map<String, String> additionalProperties;\n'),
      );
      expect(
        signUp,
        contains(
          '    required this.password,\n'
          '    this.additionalProperties = const {},\n'
          '  });',
        ),
      );
    });

    test('decodes every key but its own and the discriminator, flat', () {
      expect(
        signUp,
        contains(
          '    const knownKeys = {\'action\', \'username\', \'password\'};\n'
          '    return SignUpInput(\n'
          "      username: json['username'] as String,\n"
          "      password: json['password'] as String,\n"
          '      additionalProperties: Map.fromEntries(\n'
          '        json.entries.where((e) => !knownKeys.contains(e.key))\n'
          '            .map((e) => MapEntry(e.key, e.value as String)),\n'
          '      ),\n'
          '    );',
        ),
      );
    });

    test('encodes them flat; the discriminator and properties win', () {
      expect(
        signUp,
        contains(
          "      'action': 'signUp',\n"
          "      'username': username,\n"
          "      'password': password,\n"
          '      for (final e in additionalProperties.entries)\n'
          "        if (!const {'action', 'username', 'password'}.contains(e.key)) e.key: e.value,\n"
          '    };',
        ),
      );
    });

    test('compares, hashes and prints them', () {
      expect(
        signUp,
        contains(
          'blocksDeepEquals(additionalProperties, other.additionalProperties)',
        ),
      );
      expect(signUp, contains('blocksDeepHash(additionalProperties)'));
      expect(signUp, contains(r'additionalProperties: $additionalProperties'));
    });

    test('a closed variant of the same union is unchanged', () {
      final output = _generate([
        _method('setAuthState', params: [_param('input', _authInput)]),
      ]);
      final signIn = _classBody(output, 'SignInInput');
      expect(signIn, isNot(contains('additionalProperties')));
      expect(signIn, isNot(contains('knownKeys')));
    });

    test('`additionalProperties: true` keeps any JSON value', () {
      final output = _generate([
        _method(
          'tag',
          params: [
            _param(
              'input',
              _union([
                _arm('label', {'name': _string}, additionalProperties: true),
                _arm('clear', {}),
              ]),
            ),
          ],
        ),
      ]);
      final label = _classBody(output, 'LabelInput');
      expect(
        label,
        contains('  final Map<String, dynamic> additionalProperties;'),
      );
      expect(label, contains('.map((e) => MapEntry(e.key, e.value)),'));
      expect(label, contains("contains(e.key)) e.key: e.value,"));
    });

    test('a variant with no properties but extras takes them in its ctor', () {
      final output = _generate([
        _method(
          'tag',
          params: [
            _param(
              'input',
              _union([
                _arm('label', {}, additionalProperties: _string),
                _arm('clear', {}),
              ]),
            ),
          ],
        ),
      ]);
      final label = _classBody(output, 'LabelInput');
      expect(
        label,
        contains(
          '  const LabelInput({\n'
          '    this.additionalProperties = const {},\n'
          '  });',
        ),
      );
      expect(label, contains("    const knownKeys = {'action'};"));
      expect(
        _classBody(output, 'ClearInput'),
        contains('  const ClearInput();'),
      );
    });

    test('extras of a model type decode and encode through the model', () {
      final output = _generate([
        _method(
          'file',
          params: [
            _param(
              'input',
              _union([
                _arm('notes', {'folder': _string}, additionalProperties: _note),
                _arm('clear', {}),
              ]),
            ),
          ],
        ),
      ]);
      final notes = _classBody(output, 'NotesInput');
      expect(
        notes,
        contains('  final Map<String, Note> additionalProperties;'),
      );
      expect(
        notes,
        contains(
          '.map((e) => MapEntry(e.key, '
          'Note.fromJson(e.value as Map<String, dynamic>))),',
        ),
      );
      expect(notes, contains('.contains(e.key)) e.key: e.value.toJson(),'));
    });

    test('extras holding an OIDC client take the calling client', () {
      final output = _generate([
        _method(
          'providers',
          result: _union([
            _arm('listed', {'region': _string}, additionalProperties: _oidc),
            _arm('none', {}),
          ]),
        ),
      ]);
      final listed = _classBody(output, 'ListedProvidersResult');
      expect(
        listed,
        contains('  final Map<String, OidcClient> additionalProperties;'),
      );
      expect(
        listed,
        contains(
          'factory ListedProvidersResult.fromJson('
          'Map<String, dynamic> json, BlocksClient client)',
        ),
      );
      expect(
        listed,
        contains(
          'OidcClient.fromJson(e.value as Map<String, dynamic>, '
          'baseUrl: client.baseUrl',
        ),
      );
      expect(output, contains('show OidcClient,'));
    });
  });

  group('a hybrid arm (properties plus an embedded union)', () {
    late String output;
    setUpAll(() {
      output = _generate([
        _method(
          'confirm',
          params: [
            _param(
              'input',
              _union([
                _arm(
                  'confirmSignIn',
                  {'session': _string},
                  additionalProperties: _string,
                  oneOf: [
                    {
                      'type': 'object',
                      'properties': {
                        'challenge': _const('code'),
                        'code': _string,
                      },
                      'required': ['challenge', 'code'],
                      'additionalProperties': _string,
                    },
                    {
                      'type': 'object',
                      'properties': {
                        'challenge': _const('mfaType'),
                        'mfaType': _string,
                      },
                      'required': ['challenge', 'mfaType'],
                    },
                  ],
                ),
                _arm('signOut', {}),
              ]),
            ),
          ],
        ),
      ]);
    });

    test('the arm excludes its embedded union\'s keys', () {
      final arm = _classBody(output, 'ConfirmSignInInput');
      expect(
        arm,
        contains(
          "const knownKeys = {'action', 'session', 'challenge', 'code', "
          "'mfaType'};",
        ),
      );
    });

    test('an embedded variant excludes the enclosing arm\'s keys', () {
      final code = _classBody(output, 'CodeConfirmSignInInputChallenge');
      expect(
        code,
        contains('  final Map<String, String> additionalProperties;'),
      );
      expect(
        code,
        contains(
          "const knownKeys = {'challenge', 'code', 'action', 'session'};",
        ),
      );
    });
  });

  group('structural dedup tells open records from closed ones', () {
    test('a union differing only in extras is its own type', () {
      final open = _union([
        _arm('signUp', {'username': _string}, additionalProperties: _string),
        _arm('signOut', {}),
      ]);
      final closed = _union([
        _arm('signUp', {'username': _string}),
        _arm('signOut', {}),
      ]);
      final output = _generate([
        _method('first', params: [_param('input', open)]),
        _method('second', params: [_param('input', closed)]),
      ]);
      expect(
        output,
        contains('Future<bool> first({required ApiFirstInput input})'),
      );
      expect(
        output,
        contains('Future<bool> second({required ApiSecondInput input})'),
      );
      expect(
        _classBody(output, 'SignUpInput'),
        contains('additionalProperties'),
      );
    });

    test('identical open unions still merge', () {
      final open = _union([
        _arm('signUp', {'username': _string}, additionalProperties: _string),
        _arm('signOut', {}),
      ]);
      final output = _generate([
        _method('first', params: [_param('input', open)]),
        _method('second', params: [_param('input', open)]),
      ]);
      expect(
        output,
        contains('Future<bool> second({required ApiFirstInput input})'),
      );
    });

    test('a closed object does not merge into an open one', () {
      final output = _generate([
        _method(
          'save',
          params: [
            _param('profile', {
              'type': 'object',
              'properties': {'name': _string},
              'required': ['name'],
              'additionalProperties': _string,
            }),
          ],
        ),
        _method(
          'load',
          result: {
            'type': 'object',
            'properties': {'name': _string},
            'required': ['name'],
          },
        ),
      ]);
      expect(output, contains('Future<LoadResult> load()'));
      expect(_classBody(output, 'LoadResult'), isNot(contains('additional')));
      expect(
        _classBody(output, 'ApiSaveProfile'),
        contains('additionalProperties'),
      );
    });
  });

  test('a model encodes extras flat; its properties win', () {
    final output = _generate([
      _method(
        'save',
        params: [
          _param('profile', {
            'type': 'object',
            'properties': {'name': _string},
            'required': ['name'],
            'additionalProperties': _string,
          }),
        ],
      ),
    ]);
    expect(
      _classBody(output, 'ApiSaveProfile'),
      contains(
        "      'name': name,\n"
        '      for (final e in additionalProperties.entries)\n'
        "        if (!const {'name'}.contains(e.key)) e.key: e.value,\n"
        '    };',
      ),
    );
  });

  group('parser', () {
    UnionVariant variant(Object? additionalProperties) {
      final spec = jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          _method(
            'run',
            params: [
              _param(
                'input',
                _union([
                  _arm('go', {
                    'x': _string,
                  }, additionalProperties: additionalProperties),
                  _arm('stop', {}),
                ]),
              ),
            ],
          ),
        ],
      });
      final union =
          const OpenRpcParser().parse(spec).methods.single.params.single.schema
              as DiscriminatedUnionRef;
      return union.variants.first;
    }

    test('a variant keeps its additionalProperties type', () {
      final ap = variant(_string).additionalProperties;
      expect(ap, isA<PrimitiveRef>());
      expect((ap! as PrimitiveRef).dartType, 'String');
    });

    test('`true` is any value; `false` or none is closed', () {
      expect(
        (variant(true).additionalProperties! as PrimitiveRef).dartType,
        'dynamic',
      );
      expect(variant(false).additionalProperties, isNull);
      expect(variant(null).additionalProperties, isNull);
    });
  });
}
