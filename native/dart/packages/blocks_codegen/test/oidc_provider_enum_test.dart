import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// An `oidc/client` whose `x-blocks-type-args[0]` is a string enum names the
// providers its client signs in with. A direct or optional result generates
// an enum of them implementing `OidcProvider` and returns
// `TypedOidcClient<Enum>`, the runtime's `OidcClient` narrowed to that enum, as
// Kotlin and Swift generate `OidcClient<Api.GetClient.Provider>`. An
// `oidc/client` anywhere else is a plain `OidcClient`, taking a provider name.

Map<String, dynamic> _oidc([List<String>? providers]) => {
  'x-blocks-transferable': 'oidc/client',
  if (providers != null)
    'x-blocks-type-args': [
      {'type': 'string', 'enum': providers},
    ],
};

Map<String, dynamic> _nullable(Map<String, dynamic> schema) => {
  'oneOf': [
    schema,
    {'type': 'null'},
  ],
};

({String source, List<String> warnings}) _generate(
  List<Map<String, dynamic>> methods, {
  Map<String, dynamic> schemas = const {},
}) {
  final spec = jsonEncode({
    'openrpc': '1.3.2',
    'info': {'title': 'test', 'version': '1.0.0'},
    'methods': methods,
    if (schemas.isNotEmpty) 'components': {'schemas': schemas},
  });
  final model = CodegenModelBuilder().build(const OpenRpcParser().parse(spec));
  return (
    source: const DartCodeGenerator().generate(model),
    warnings: model.warnings,
  );
}

Map<String, dynamic> _method(
  String name,
  Map<String, dynamic> result, {
  List<Map<String, dynamic>> params = const [],
}) => {
  'name': name,
  'params': params,
  'result': {'name': 'GetClientResult', 'schema': result},
};

void main() {
  test('named providers type the client and generate an enum of them', () {
    final (:source, :warnings) = _generate([
      _method('auth.getClient', _oidc(['google', 'github'])),
    ]);
    expect(
      source,
      contains('Future<TypedOidcClient<AuthApiGetClientProvider>> getClient()'),
    );
    expect(
      source,
      contains('enum AuthApiGetClientProvider implements OidcProvider {'),
    );
    expect(source, contains("  google('google'),\n  github('github')\n;"));
    expect(
      source,
      contains('  const AuthApiGetClientProvider(this.providerName);'),
    );
    expect(source, contains('  @override\n  final String providerName;'));
    expect(
      source,
      contains(
        'static AuthApiGetClientProvider? fromProviderName(String name) {',
      ),
    );
    expect(
      source,
      contains(
        'return TypedOidcClient<AuthApiGetClientProvider>(OidcClient.fromJson(result as Map<String, dynamic>, ',
      ),
    );
    expect(warnings, isEmpty);
  });

  test('a typed result re-exports TypedOidcClient and OidcProvider', () {
    final (:source, warnings: _) = _generate([
      _method('auth.getClient', _oidc(['google'])),
    ]);
    expect(
      source,
      contains(
        "export 'package:blocks_runtime/blocks_runtime.dart' show TypedOidcClient, OidcProvider;",
      ),
    );
  });

  test('an untyped client re-exports neither, so an app type of that name '
      'stays unambiguous', () {
    final (:source, warnings: _) = _generate([
      _method('auth.getClient', _oidc()),
      _method('auth.menu', {
        'type': 'object',
        'properties': {
          'client': _oidc(['google']),
        },
        'required': ['client'],
      }),
    ]);
    expect(source, contains('show OidcClient, OidcAuthState'));
    expect(source, isNot(contains('TypedOidcClient')));
    expect(source, isNot(contains('OidcProvider')));
  });

  test('a spec that names no providers takes any provider', () {
    final (:source, :warnings) = _generate([
      _method('auth.getClient', _oidc()),
    ]);
    expect(source, contains('Future<OidcClient> getClient()'));
    expect(source, contains('return OidcClient.fromJson('));
    expect(source, isNot(contains('implements OidcProvider')));
    expect(warnings, isEmpty);
  });

  test('an empty provider list takes any provider', () {
    final (:source, warnings: _) = _generate([
      _method('auth.getClient', _oidc([])),
    ]);
    expect(source, contains('Future<OidcClient> getClient()'));
    expect(source, isNot(contains('implements OidcProvider')));
  });

  test('a type argument that is not a string enum takes any provider', () {
    final (:source, warnings: _) = _generate([
      _method('auth.getClient', {
        'x-blocks-transferable': 'oidc/client',
        'x-blocks-type-args': [
          {'type': 'string'},
        ],
      }),
    ]);
    expect(source, contains('Future<OidcClient> getClient()'));
    expect(source, isNot(contains('implements OidcProvider')));
  });

  test('an optional client keeps its providers', () {
    final (:source, warnings: _) = _generate([
      _method('auth.getClient', _nullable(_oidc(['google']))),
    ]);
    expect(
      source,
      contains(
        'Future<TypedOidcClient<AuthApiGetClientProvider>?> getClient()',
      ),
    );
    expect(
      source,
      contains(
        'return result == null ? null : TypedOidcClient<AuthApiGetClientProvider>(OidcClient.fromJson(',
      ),
    );
  });

  test('a provider name no identifier can hold becomes one, and keeps its '
      'name; a repeat is dropped', () {
    final (:source, warnings: _) = _generate([
      _method(
        'auth.getClient',
        _oidc(['login.gov', 'my-sso', 'okta:corp', '2fa', 'login.gov', '_x']),
      ),
    ]);
    expect(source, contains("  loginGov('login.gov'),"));
    expect(source, contains("  mySso('my-sso'),"));
    expect(source, contains("  oktaCorp('okta:corp'),"));
    expect(source, contains(r"  $2fa('2fa'),"));
    expect(source, contains(r"  $x('_x')"));
    expect(RegExp(r'loginGov\(').allMatches(source), hasLength(1));
  });

  test('a provider named like a member of the enum is escaped', () {
    final (:source, warnings: _) = _generate([
      _method(
        'auth.getClient',
        _oidc(['values', 'name', 'providerName', 'fromProviderName']),
      ),
    ]);
    expect(source, contains(r"  values$('values'),"));
    expect(source, contains(r"  name$('name'),"));
    expect(source, contains(r"  providerName$('providerName'),"));
    expect(source, contains(r"  fromProviderName$('fromProviderName')"));
  });

  test('two providers that reduce to one identifier are told apart, and '
      'the codegen says so', () {
    final (:source, :warnings) = _generate([
      _method('auth.getClient', _oidc(['my-sso', 'my.sso'])),
    ]);
    expect(source, contains("  mySso('my-sso'),"));
    expect(source, contains(r"  mySso$('my.sso')"));
    expect(warnings.single, contains("providers of auth.getClient 'my-sso'"));
  });

  test('a type that already has the name renames the enum and says so', () {
    final (:source, :warnings) = _generate(
      [
        _method(
          'auth.getClient',
          _oidc(['google']),
          params: [
            {
              'name': 'hint',
              'required': true,
              'schema': {
                r'$ref': '#/components/schemas/AuthApiGetClientProvider',
              },
            },
          ],
        ),
      ],
      schemas: {
        'AuthApiGetClientProvider': {
          'type': 'object',
          'properties': {
            'label': {'type': 'string'},
          },
          'required': ['label'],
        },
      },
    );
    expect(
      source,
      contains(
        'Future<TypedOidcClient<AuthApiGetClientResultProvider>> getClient({required AuthApiGetClientProvider hint})',
      ),
    );
    expect(source, contains('class AuthApiGetClientProvider {'));
    expect(
      source,
      contains('enum AuthApiGetClientResultProvider implements OidcProvider'),
    );
    expect(
      warnings.single,
      contains(
        'the provider enum of auth.getClient is `AuthApiGetClientResultProvider`',
      ),
    );
  });

  test('each operation gets its own enum', () {
    final (:source, :warnings) = _generate([
      _method('auth.getClient', _oidc(['google'])),
      _method('auth.getPartnerClient', _oidc(['okta'])),
      _method('admin.getClient', _oidc(['github'])),
    ]);
    expect(source, contains('enum AuthApiGetClientProvider implements'));
    expect(source, contains('enum AuthApiGetPartnerClientProvider implements'));
    expect(source, contains('enum AdminApiGetClientProvider implements'));
    expect(
      source,
      contains(
        'Future<TypedOidcClient<AuthApiGetPartnerClientProvider>> getPartnerClient()',
      ),
    );
    expect(
      source,
      contains(
        'Future<TypedOidcClient<AdminApiGetClientProvider>> getClient()',
      ),
    );
    expect(warnings, isEmpty);
  });

  test('a client nested in a model gets no enum and takes any provider', () {
    final (:source, warnings: _) = _generate([
      _method('auth.menu', {
        'type': 'object',
        'properties': {
          'client': _oidc(['google']),
          'clients': {
            'type': 'array',
            'items': _oidc(['google']),
          },
        },
        'required': ['client', 'clients'],
      }),
    ]);
    expect(source, isNot(contains('implements OidcProvider')));
    expect(source, contains('  final OidcClient client;'));
    expect(source, contains('  final List<OidcClient> clients;'));
    expect(source, isNot(contains('TypedOidcClient<')));
  });

  test('a client parameter gets no enum and takes any client', () {
    final (:source, warnings: _) = _generate([
      {
        'name': 'auth.use',
        'params': [
          {
            'name': 'client',
            'required': true,
            'schema': _oidc(['google']),
          },
        ],
        'result': {
          'name': 'UseResult',
          'schema': {'type': 'string'},
        },
      },
    ]);
    expect(source, isNot(contains('implements OidcProvider')));
    expect(source, contains('use({required OidcClient client})'));
  });

  Map<String, dynamic> runtimeNamedSchemas() => {
    'OidcProvider': {
      'type': 'object',
      'properties': {
        'id': {'type': 'string'},
      },
      'required': ['id'],
    },
    'TypedOidcClient': {
      'type': 'string',
      'enum': ['a', 'b'],
    },
  };

  List<Map<String, dynamic>> runtimeNamedParams() => [
    {
      'name': 'p',
      'required': true,
      'schema': {r'$ref': '#/components/schemas/OidcProvider'},
    },
    {
      'name': 'q',
      'required': true,
      'schema': {r'$ref': '#/components/schemas/TypedOidcClient'},
    },
  ];

  test('in a spec with an OIDC client, a spec type named like a runtime '
      'type it uses is escaped', () {
    final (:source, warnings: _) = _generate([
      _method(
        'auth.getClient',
        _oidc(['google']),
        params: runtimeNamedParams(),
      ),
    ], schemas: runtimeNamedSchemas());
    expect(source, contains(r'class OidcProvider$ {'));
    expect(source, contains(r'enum TypedOidcClient$ {'));
    expect(
      source,
      contains('enum AuthApiGetClientProvider implements OidcProvider {'),
    );
    expect(
      source,
      contains(
        r'getClient({required OidcProvider$ p, required TypedOidcClient$ q})',
      ),
    );
  });

  test('in a spec whose OIDC clients are all untyped, those names are left '
      'as they are', () {
    final (:source, :warnings) = _generate([
      _method('auth.getClient', _oidc(), params: runtimeNamedParams()),
    ], schemas: runtimeNamedSchemas());
    expect(source, contains('class OidcProvider {'));
    expect(source, contains('enum TypedOidcClient {'));
    expect(
      source,
      contains(
        'getClient({required OidcProvider p, required TypedOidcClient q})',
      ),
    );
    expect(warnings, isEmpty);
  });

  test('in a spec with no OIDC client, those names are left as they are', () {
    final (:source, :warnings) = _generate([
      {
        'name': 'cfg.list',
        'params': runtimeNamedParams(),
        'result': {
          'name': 'ListResult',
          'schema': {'type': 'string'},
        },
      },
    ], schemas: runtimeNamedSchemas());
    expect(source, contains('class OidcProvider {'));
    expect(source, contains('enum TypedOidcClient {'));
    expect(
      source,
      contains('list({required OidcProvider p, required TypedOidcClient q})'),
    );
    expect(source, isNot(contains(r'$ {')));
    expect(warnings, isEmpty);
  });

  test('in a spec with an OIDC client, a member named like a runtime type '
      'it uses is escaped', () {
    final (:source, warnings: _) = _generate([
      _method(
        'auth.getClient',
        _oidc(['google']),
        params: [
          {
            'name': 'TypedOidcClient',
            'required': true,
            'schema': {'type': 'string'},
          },
        ],
      ),
    ]);
    expect(source, contains(r'getClient({required String TypedOidcClient$})'));
    expect(
      source,
      contains('return TypedOidcClient<AuthApiGetClientProvider>('),
    );
  });

  test('a method name with separators is PascalCased in the enum name', () {
    final (:source, warnings: _) = _generate([
      _method('auth.get_client', _oidc(['google'])),
      _method('auth.get-other-client', _oidc(['google'])),
    ]);
    expect(source, contains('enum AuthApiGetClientProvider implements'));
    expect(source, contains('enum AuthApiGetOtherClientProvider implements'));
    expect(source, isNot(contains('Get_client')));
  });

  test('a member named like the enum yields to it', () {
    final (:source, warnings: _) = _generate([
      _method(
        'auth.getClient',
        _oidc(['google']),
        params: [
          {
            'name': 'AuthApiGetClientProvider',
            'required': true,
            'schema': {'type': 'string'},
          },
        ],
      ),
    ]);
    expect(
      source,
      contains(r'getClient({required String AuthApiGetClientProvider$})'),
    );
  });
}
