import 'dart:convert';
import 'dart:io';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:blocks_codegen/src/identifiers.dart';
import 'package:test/test.dart';

String _generate(String spec) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
);

/// [source] with every string literal and comment removed, which leaves only
/// the code a spec name could have reached as an identifier.
String _codeOnly(String source) {
  final out = StringBuffer();
  var i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      final end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source[i] == "'") {
      i++;
      var depth = 0;
      while (i < source.length && (source[i] != "'" || depth > 0)) {
        if (source[i] == r'\') {
          i += 2;
          continue;
        }
        // An interpolation holds code, whose own quotes don't end the literal.
        if (source.startsWith(r'${', i)) {
          depth++;
          i += 2;
          continue;
        }
        if (depth > 0 && source[i] == '}') depth--;
        i++;
      }
      i++;
      out.write("''");
    } else {
      out.write(source[i++]);
    }
  }
  return out.toString();
}

String _recordSpec(List<String> fields) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    {
      'name': 'api.get',
      'params': <Object>[],
      'result': {
        'name': 'GetResult',
        'schema': {
          'type': 'object',
          'properties': {
            for (final f in fields) f: {'type': 'string'},
          },
        },
      },
    },
  ],
});

void main() {
  final fixtureSpec = File(
    '${Directory.current.path}/../../../codegen-fixtures/29-non-identifier-names/spec.json',
  ).readAsStringSync();

  group('safeDartIdentifier', () {
    test('leaves an identifier the spec already spells unchanged', () {
      expect(safeDartIdentifier('camelCase'), 'camelCase');
      expect(safeDartIdentifier('_private'), '_private');
      expect(safeDartIdentifier('snake_case9'), 'snake_case9');
    });

    test('maps every other character to an underscore', () {
      expect(safeDartIdentifier('a b;c`d"e\nf'), 'a_b_c_d_e_f');
      expect(
        safeDartIdentifier('run { error("x") } || id'),
        'run___error__x________id',
      );
    });

    test('keeps a leading digit or added underscore public', () {
      expect(safeDartIdentifier('9lives'), r'$9lives');
      expect(safeDartIdentifier(r'${x}'), r'$__x_');
      expect(safeDartIdentifier(''), r'$unnamed');
      expect(safeDartIdentifier('*/'), r'$__unnamed');
    });
  });

  group('non-identifier names', () {
    test('the non-identifier-names fixture generates', () {
      final source = _generate(fixtureSpec);

      expect(source, contains('final String run___error__x________id;'));
      expect(source, contains('if (!(run___error__x________id.length >= 2))'));
      expect(
        source,
        contains(
          "'run { error(\"xParam\") } || p': run___error__xParam________p,",
        ),
      );
    });

    test('no spec text survives outside a string literal or comment', () {
      final code = _codeOnly(_generate(fixtureSpec));

      for (final fragment in [
        'error(',
        '{ error',
        '`',
        r'\(',
        '*/',
        ' sp ace',
        'with space',
        '"',
      ]) {
        expect(code, isNot(contains(fragment)), reason: fragment);
      }
    });

    test('enum constants stay public and keywords are escaped', () {
      final spec = jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'api.pick',
            'params': [
              {
                'name': 'choice',
                'required': true,
                'schema': {
                  'type': 'string',
                  'enum': ['1st', r'${x}', '*/', 'default'],
                },
              },
            ],
            'result': {
              'name': 'PickResult',
              'schema': {'type': 'boolean'},
            },
          },
        ],
      });
      final source = _generate(spec);

      expect(source, contains(r"'1st': $1st,"));
      expect(source, contains(r"'\${x}': $__x_,"));
      expect(source, contains(r"'*/': $__unnamed,"));
      expect(source, contains(r"'default': default$,"));
    });

    test('each original key is kept as an escaped string literal', () {
      final source = _generate(fixtureSpec);

      expect(source, contains(r"json['\${x}']"));
      expect(source, contains(r"json['new\nline']"));
      expect(source, contains(r"json['s\'ingle']"));
      expect(source, contains("json['back`tick']"));
      expect(source, contains("_client.call('api.get\"Sample`;x', params)"));
      expect(source, contains("switch (json['ty pe'] as String)"));
    });
  });

  group('identifier collisions', () {
    test('two fields that reduce to one identifier fail generation', () {
      expect(
        () => _generate(_recordSpec(['a-b', 'a_b'])),
        throwsA(
          isA<NamingConflictException>().having(
            (e) => e.message,
            'message',
            allOf(contains("'a-b'"), contains("'a_b'"), contains('Rename')),
          ),
        ),
      );
    });

    test('two parameters that reduce to one identifier fail generation', () {
      final spec = jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'api.put',
            'params': [
              {
                'name': 'a b',
                'required': true,
                'schema': {'type': 'string'},
              },
              {
                'name': 'a;b',
                'required': true,
                'schema': {'type': 'string'},
              },
            ],
            'result': {
              'name': 'PutResult',
              'schema': {'type': 'boolean'},
            },
          },
        ],
      });

      expect(
        () => _generate(spec),
        throwsA(
          isA<NamingConflictException>().having(
            (e) => e.message,
            'message',
            contains('parameters'),
          ),
        ),
      );
    });

    test('two enum values that reduce to one identifier fail generation', () {
      final spec = jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'methods': [
          {
            'name': 'api.pick',
            'params': [
              {
                'name': 'choice',
                'required': true,
                'schema': {
                  'type': 'string',
                  'enum': [r'a$b', 'a;b'],
                },
              },
            ],
            'result': {
              'name': 'PickResult',
              'schema': {'type': 'boolean'},
            },
          },
        ],
      });

      expect(
        () => _generate(spec),
        throwsA(
          isA<NamingConflictException>().having(
            (e) => e.message,
            'message',
            contains('enum values'),
          ),
        ),
      );
    });

    test('two schemas that reduce to one type name fail generation', () {
      final spec = jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 'test', 'version': '1.0.0'},
        'components': {
          'schemas': {
            'My-Type': {
              'type': 'object',
              'properties': {
                'a': {'type': 'string'},
              },
            },
            'My;Type': {
              'type': 'object',
              'properties': {
                'b': {'type': 'string'},
              },
            },
          },
        },
        'methods': <Object>[],
      });

      expect(() => _generate(spec), throwsA(isA<NamingConflictException>()));
    });
  });
}
