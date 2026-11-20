// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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

/// One `<ns>.run(input)` method per entry of [unions]: the namespace, the
/// `kind` values of its union's arms, and the name the spec gives the union.
/// The first arm of each has a `mode` enum field, so it nests a type. The
/// union is the parameter [param].
String _runSpec(
  List<(String, List<String>, String?)> unions, {
  Map<String, dynamic> schemas = const {},
  String param = 'input',
}) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    for (final (ns, kinds, typeName) in unions)
      {
        'name': '$ns.run',
        'params': [
          {
            'name': param,
            'required': true,
            'schema': {
              'oneOf': [
                for (final (i, kind) in kinds.indexed)
                  {
                    'type': 'object',
                    'properties': {
                      'kind': {
                        'type': 'string',
                        'enum': [kind],
                      },
                      if (i == 0)
                        'mode': {
                          'type': 'string',
                          'enum': ['fast', 'slow'],
                        },
                    },
                    'required': ['kind'],
                  },
              ],
              'x-blocks-type-name': ?typeName,
            },
          },
        ],
        'result': {
          'name': 'RunResult',
          'schema': {'type': 'boolean'},
        },
      },
  ],
  'components': {'schemas': schemas},
});

/// Every class, enum and typedef name [source] declares.
Set<String> _declaredNames(String source) => {
  for (final m in RegExp(
    r'^(?:sealed |final )?(?:class|enum|typedef) (\S+?)\b',
    multiLine: true,
  ).allMatches(source))
    m.group(1)!,
};

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

    test('keeps the arm and nested names when the name does not end in '
        'Input', () {
      final unnamed = _generate(
        _runSpec([
          ('todoApi', ['start', 'stop'], null),
        ]),
      );
      final named = _generate(
        _runSpec([
          ('todoApi', ['start', 'stop'], 'Command'),
        ]),
      );
      expect(named, contains('sealed class Command {'));
      expect(named, contains('class StartInput extends Command {'));
      expect(named, contains('class StopInput extends Command {'));
      expect(named, contains('enum StartInputMode {'));
      expect(named, isNot(contains('StartCommand')));
      // Every name generated without the key is still declared.
      expect(_declaredNames(named), containsAll(_declaredNames(unnamed)));
    });

    test('a union that falls back keeps its arm names too', () {
      final source = _generate(
        _runSpec(
          [
            ('todoApi', ['start', 'stop'], 'Command'),
          ],
          schemas: {
            'Command': {
              'type': 'object',
              'properties': {
                'id': {'type': 'string'},
              },
              'required': ['id'],
            },
          },
        ),
      );
      expect(source, contains('sealed class TodoApiRunInput {'));
      expect(source, contains('class StartInput extends TodoApiRunInput {'));
      expect(source, contains('enum StartInputMode {'));
      expect(source, isNot(contains('StartCommand')));
    });

    test('of distinct unions given one name, the smallest canonical key keeps '
        'it, whatever the spec order', () {
      const alpha = ('alphaApi', ['start', 'stop'], 'Shared');
      const beta = ('betaApi', ['open', 'close'], 'Shared');
      for (final unions in [
        [alpha, beta],
        [beta, alpha],
      ]) {
        final model = _build(_runSpec(unions));
        final shared = model.types['Shared'];
        expect(shared, isA<SealedClassType>());
        expect((shared! as SealedClassType).variants.map((v) => v.className), [
          'StartInput',
          'StopInput',
        ]);
        expect(model.types['BetaApiRunInput'], isA<SealedClassType>());
        expect(model.types, isNot(contains('AlphaApiRunInput')));
        expect(model.deprecatedAliases, {'AlphaApiRunInput': 'Shared'});
        expect(
          model.warnings,
          contains(contains('union Shared is generated as BetaApiRunInput')),
        );
      }
    });

    test('says when copies of one union differ only in nested names', () {
      final model = _build(
        _runSpec([
          ('alphaApi', ['start', 'stop'], 'Command'),
          ('betaApi', ['start', 'stop'], 'Command'),
        ], param: 'cmd'),
      );
      expect(model.types['Command'], isA<SealedClassType>());
      expect(model.types['BetaApiRunCmd'], isA<SealedClassType>());
      expect(
        model.warnings,
        contains(
          'Naming conflict: union Command is generated as BetaApiRunCmd, '
          'since its copy named Command differs from it only in the names of '
          'the types nested in its arms.',
        ),
      );
      expect(model.warnings, isNot(contains(contains('another type'))));
    });

    test(r'escapes a `$` in the deprecated alias message', () {
      for (final (typeName, target) in [
        ('Map', r'Map$'),
        (r'$Action', r'$Action'),
      ]) {
        final source = _generate(
          _runSpec([
            ('todoApi', ['start', 'stop'], typeName),
          ]),
        );
        final escaped = target.replaceAll(r'$', r'\$');
        expect(
          source,
          contains(
            "@Deprecated('Use $escaped')\n"
            'typedef TodoApiRunInput = $target;',
          ),
        );
      }
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
