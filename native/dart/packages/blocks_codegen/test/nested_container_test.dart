import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// Containers (lists, maps, nullables, tuples, and any nesting of them) whose
// elements need converting used to decode with a bare cast: `v as List<Note>`,
// `.cast<RealtimeChannel<Note>>()`, `.cast<Level>()`. That compiles but throws
// at runtime, since the element is still a JSON map, list or string. And
// `toJson()` left such elements as Dart objects, so `fromJson(x.toJson())`
// failed too. Every element now goes through its own decoder and encoder.

const _note = {r'$ref': '#/components/schemas/Note'};
const _level = {r'$ref': '#/components/schemas/Level'};

Map<String, dynamic> _list(Map<String, dynamic> items) => {
  'type': 'array',
  'items': items,
};

Map<String, dynamic> _map(Map<String, dynamic> values) => {
  'type': 'object',
  'additionalProperties': values,
};

Map<String, dynamic> _channel(Map<String, dynamic> message) => {
  'x-blocks-transferable': 'realtime/channel',
  'x-blocks-type-args': [message],
};

Map<String, dynamic> _nullable(Map<String, dynamic> inner) => {
  'oneOf': [
    inner,
    {'type': 'null'},
  ],
};

const _oidc = {'x-blocks-transferable': 'oidc/client'};

Map<String, dynamic> _method(
  String name,
  Map<String, dynamic> result, [
  List<Map<String, dynamic>> params = const [],
]) => {
  'name': 'api.$name',
  'params': params,
  'result': {
    'name': '${name[0].toUpperCase()}${name.substring(1)}Result',
    'schema': result,
  },
};

final _spec = jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': [
    _method('getLayout', {r'$ref': '#/components/schemas/Layout'}),
    _method('getBoard', {r'$ref': '#/components/schemas/Board'}),
    _method('getLoginMenu', {r'$ref': '#/components/schemas/LoginMenu'}),
    _method('getChoice', {r'$ref': '#/components/schemas/Choice'}),
    _method('getPlain', {r'$ref': '#/components/schemas/Plain'}),
    _method('groupNotes', _map(_list(_note)), [
      {'name': 'groups', 'required': true, 'schema': _map(_list(_note))},
      {'name': 'levels', 'required': false, 'schema': _list(_level)},
      {'name': 'grid', 'required': true, 'schema': _list(_list(_note))},
    ]),
    _method('listFeeds', _list(_channel(_note))),
    _method('listLevels', _list(_level)),
    _method('maybeNotes', _nullable(_list(_note))),
    _method('maybeLevel', _nullable(_level)),
    _method('tagMatrix', _map(_list(_list({'type': 'string'})))),
  ],
  'components': {
    'schemas': {
      'Note': {
        'type': 'object',
        'properties': {
          'id': {'type': 'string'},
        },
        'required': ['id'],
      },
      'Level': {
        'type': 'string',
        'enum': ['low', 'high'],
      },
      'Layout': {
        'type': 'object',
        'properties': {
          'tagsByUser': _map(_list({'type': 'string'})),
          'scoresByUser': _map(_list({'type': 'integer'})),
          'notesByTag': _map(_list(_note)),
          'pages': _list(_map(_note)),
          'grid': _list(_list(_note)),
          'levels': _list(_level),
          'levelsByUser': _map(_list(_level)),
          'nestedLevels': _map(_map(_level)),
          'maybeNotes': _list(_nullable(_note)),
          'pairs': _list({
            'type': 'array',
            'prefixItems': [
              {'type': 'string'},
              _note,
            ],
          }),
          'pair': {
            'type': 'array',
            'prefixItems': [
              {'type': 'string'},
              _note,
            ],
          },
        },
        'required': [
          'tagsByUser',
          'notesByTag',
          'pages',
          'grid',
          'levels',
          'nestedLevels',
          'maybeNotes',
          'pairs',
        ],
      },
      'Board': {
        'type': 'object',
        'properties': {
          'channels': _list(_channel(_note)),
          'tagFeeds': _list(
            _channel({
              'type': 'array',
              'items': {'type': 'string'},
            }),
          ),
          'feedsByRoom': _map(_channel(_note)),
          'downloads': _list({'x-blocks-transferable': 'file-bucket/download'}),
        },
        'required': ['channels', 'feedsByRoom', 'downloads'],
      },
      'Plain': {
        'type': 'object',
        'properties': {
          'name': {'type': 'string'},
        },
        'required': ['name'],
        'additionalProperties': _note,
      },
      'SignInOption': {
        'type': 'object',
        'properties': {
          'label': {'type': 'string'},
          'client': _oidc,
        },
        'required': ['label', 'client'],
      },
      'LoginMenu': {
        'type': 'object',
        'properties': {
          'primary': {r'$ref': '#/components/schemas/SignInOption'},
          'options': _list({r'$ref': '#/components/schemas/SignInOption'}),
          'byProvider': _map({r'$ref': '#/components/schemas/SignInOption'}),
          'fallback': _oidc,
          'notes': _list(_note),
        },
        'required': ['primary', 'options', 'byProvider', 'notes'],
      },
      'Choice': {
        'oneOf': [
          {
            'type': 'object',
            'properties': {
              'kind': {
                'type': 'string',
                'enum': ['oidc'],
              },
              'client': _oidc,
            },
            'required': ['kind', 'client'],
          },
          {
            'type': 'object',
            'properties': {
              'kind': {
                'type': 'string',
                'enum': ['none'],
              },
            },
            'required': ['kind'],
          },
        ],
      },
    },
  },
});

void main() {
  final output = const DartCodeGenerator().generate(
    CodegenModelBuilder().build(const OpenRpcParser().parse(_spec)),
  );

  group('nested containers decode element by element', () {
    test('a map of lists of primitives casts the inner list', () {
      expect(
        output,
        contains(
          "      tagsByUser: (json['tagsByUser'] as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).cast<String>())),",
        ),
      );
      expect(
        output,
        contains(
          "      scoresByUser: (json['scoresByUser'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, (v as List<dynamic>).cast<int>())),",
        ),
      );
    });

    test('a map of lists of models decodes each model', () {
      expect(
        output,
        contains(
          "      notesByTag: (json['notesByTag'] as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => Note.fromJson(e1 as Map<String, dynamic>)).toList())),",
        ),
      );
    });

    test('a list of maps of models decodes each model', () {
      expect(
        output,
        contains(
          "      pages: (json['pages'] as List<dynamic>).map((e) => (e as Map<String, dynamic>).map((k1, v1) => MapEntry(k1, Note.fromJson(v1 as Map<String, dynamic>)))).toList(),",
        ),
      );
    });

    test('a list of lists of models decodes each model', () {
      expect(
        output,
        contains(
          "      grid: (json['grid'] as List<dynamic>).map((e) => (e as List<dynamic>).map((e1) => Note.fromJson(e1 as Map<String, dynamic>)).toList()).toList(),",
        ),
      );
    });

    test('a list of schema enums decodes from a string, not a map', () {
      expect(
        output,
        contains(
          "      levels: (json['levels'] as List<dynamic>).map((e) => Level.fromJson(e as String)).toList(),",
        ),
      );
    });

    test('maps of lists and maps of maps of enums decode each enum', () {
      expect(
        output,
        contains(
          "      levelsByUser: (json['levelsByUser'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => Level.fromJson(e1 as String)).toList())),",
        ),
      );
      expect(
        output,
        contains(
          "      nestedLevels: (json['nestedLevels'] as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as Map<String, dynamic>).map((k1, v1) => MapEntry(k1, Level.fromJson(v1 as String))))),",
        ),
      );
    });

    test('a list of nullable models decodes the non-null ones', () {
      expect(
        output,
        contains(
          "      maybeNotes: (json['maybeNotes'] as List<dynamic>).map((e) => e == null ? null : Note.fromJson(e as Map<String, dynamic>)).toList(),",
        ),
      );
    });

    test('a list of tuples decodes each tuple element', () {
      expect(
        output,
        contains(
          "      pairs: (json['pairs'] as List<dynamic>).map((e) => ((e as List<dynamic>)[0] as String, Note.fromJson((e as List<dynamic>)[1] as Map<String, dynamic>))).toList(),",
        ),
      );
    });

    test('additional properties holding models decode each model', () {
      expect(
        output,
        contains(
          '            .map((e) => MapEntry(e.key, Note.fromJson(e.value as Map<String, dynamic>))),',
        ),
      );
    });
  });

  group('transferables inside containers are hydrated', () {
    test('a list of realtime channels hydrates each channel', () {
      expect(
        output,
        contains(
          "      channels: (json['channels'] as List<dynamic>).map((e) => RealtimeChannel.fromJson(e as Map<String, dynamic>, (json) => Note.fromJson(json))).toList(),",
        ),
      );
      expect(
        output,
        contains(
          "      tagFeeds: (json['tagFeeds'] as List<dynamic>?)?.map((e) => RealtimeChannel.fromJsonValue(e as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<String>())).toList(),",
        ),
      );
    });

    test('a map of realtime channels hydrates each channel', () {
      expect(
        output,
        contains(
          "      feedsByRoom: (json['feedsByRoom'] as Map<String, dynamic>).map((k, v) => MapEntry(k, RealtimeChannel.fromJson(v as Map<String, dynamic>, (json) => Note.fromJson(json)))),",
        ),
      );
    });

    test('a list of file handles hydrates each handle', () {
      expect(
        output,
        contains(
          "      downloads: (json['downloads'] as List<dynamic>).map((e) => FileDownloadHandle.fromJson(e as Map<String, dynamic>)).toList(),",
        ),
      );
    });
  });

  group('an oidc/client inside a model gets the calling client', () {
    test('a model holding one takes a BlocksClient in fromJson', () {
      expect(
        output,
        contains(
          '  factory SignInOption.fromJson(Map<String, dynamic> json, BlocksClient client) {',
        ),
      );
      expect(
        output,
        contains(
          "      client: OidcClient.fromJson(json['client'] as Map<String, dynamic>, baseUrl: client.baseUrl, tokenStore: client.tokenStore, sessionStore: client.sessionStore),",
        ),
      );
    });

    test('so does a model holding one at any depth, and passes it on', () {
      expect(
        output,
        contains(
          '  factory LoginMenu.fromJson(Map<String, dynamic> json, BlocksClient client) {',
        ),
      );
      expect(
        output,
        contains(
          "      primary: SignInOption.fromJson(json['primary'] as Map<String, dynamic>, client),",
        ),
      );
      expect(
        output,
        contains(
          "      options: (json['options'] as List<dynamic>).map((e) => SignInOption.fromJson(e as Map<String, dynamic>, client)).toList(),",
        ),
      );
      expect(
        output,
        contains(
          "      byProvider: (json['byProvider'] as Map<String, dynamic>).map((k, v) => MapEntry(k, SignInOption.fromJson(v as Map<String, dynamic>, client))),",
        ),
      );
      expect(
        output,
        contains(
          "      fallback: json['fallback'] != null ? OidcClient.fromJson(json['fallback'] as Map<String, dynamic>, baseUrl: client.baseUrl, tokenStore: client.tokenStore, sessionStore: client.sessionStore) : null,",
        ),
      );
      // A model with no oidc/client keeps its one-argument fromJson.
      expect(
        output,
        contains(
          "      notes: (json['notes'] as List<dynamic>).map((e) => Note.fromJson(e as Map<String, dynamic>)).toList(),",
        ),
      );
      expect(
        output,
        contains('  factory Note.fromJson(Map<String, dynamic> json) {'),
      );
    });

    test('a sealed class holding one passes it to every variant', () {
      expect(
        output,
        contains(
          '  static Choice fromJson(Map<String, dynamic> json, BlocksClient client) {',
        ),
      );
      expect(
        output,
        contains(
          "      case 'oidc': return OidcChoice.fromJson(json, client);",
        ),
      );
      expect(
        output,
        contains(
          "      case 'none': return NoneChoice.fromJson(json, client);",
        ),
      );
    });

    test('an operation passes its own client', () {
      expect(
        output,
        contains(
          '    return LoginMenu.fromJson(result as Map<String, dynamic>, _client);',
        ),
      );
      expect(
        output,
        contains(
          '    return Choice.fromJson(result as Map<String, dynamic>, _client);',
        ),
      );
    });
  });

  group('operation results decode element by element', () {
    test('a map of lists of models', () {
      expect(
        output,
        contains(
          '    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => Note.fromJson(e1 as Map<String, dynamic>)).toList()));',
        ),
      );
    });

    test('a list of realtime channels', () {
      expect(
        output,
        contains(
          '    return (result as List<dynamic>).map((e) => RealtimeChannel.fromJson(e as Map<String, dynamic>, (json) => Note.fromJson(json))).toList();',
        ),
      );
    });

    test('a list of schema enums', () {
      expect(
        output,
        contains(
          '    return (result as List<dynamic>).map((e) => Level.fromJson(e as String)).toList();',
        ),
      );
    });

    test('a nullable list of models', () {
      expect(
        output,
        contains(
          '    return (result as List<dynamic>?)?.map((e) => Note.fromJson(e as Map<String, dynamic>)).toList();',
        ),
      );
    });

    test('a nullable schema enum decodes from a string', () {
      expect(
        output,
        contains(
          '    return result == null ? null : Level.fromJson(result as String);',
        ),
      );
    });

    test('a map of lists of lists of primitives', () {
      expect(
        output,
        contains(
          '    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => (e1 as List<dynamic>).cast<String>()).toList()));',
        ),
      );
    });
  });

  group('toJson encodes element by element, symmetric with fromJson', () {
    test('containers of models and enums encode each element', () {
      for (final line in [
        "      'tagsByUser': tagsByUser,",
        "      if (scoresByUser != null) 'scoresByUser': scoresByUser,",
        "      'notesByTag': notesByTag.map((k, v) => MapEntry(k, v.map((e1) => e1.toJson()).toList())),",
        "      'pages': pages.map((e) => e.map((k1, v1) => MapEntry(k1, v1.toJson()))).toList(),",
        "      'grid': grid.map((e) => e.map((e1) => e1.toJson()).toList()).toList(),",
        "      'levels': levels.map((e) => e.toJson()).toList(),",
        "      if (levelsByUser != null) 'levelsByUser': levelsByUser?.map((k, v) => MapEntry(k, v.map((e1) => e1.toJson()).toList())),",
        "      'nestedLevels': nestedLevels.map((k, v) => MapEntry(k, v.map((k1, v1) => MapEntry(k1, v1.toJson())))),",
        "      'maybeNotes': maybeNotes.map((e) => e?.toJson()).toList(),",
        "      'pairs': pairs.map((e) => [e.\$1, e.\$2.toJson()]).toList(),",
      ]) {
        expect(output, contains(line));
      }
    });

    test('an optional tuple binds a non-null local', () {
      expect(
        output,
        contains(
          "      if (pair != null) 'pair': switch (pair) { final value? => [value.\$1, value.\$2.toJson()], _ => null },",
        ),
      );
    });

    test('additional properties holding models encode each model', () {
      expect(
        output,
        contains(
          '      for (final e in additionalProperties.entries)\n'
          "        if (!const {'name'}.contains(e.key)) e.key: e.value.toJson(),",
        ),
      );
    });

    test('parameters encode element by element', () {
      expect(
        output,
        contains(
          '      groups.map((k, v) => MapEntry(k, v.map((e1) => e1.toJson()).toList())),',
        ),
      );
      // An optional parameter before a required one keeps its slot (FX48).
      expect(
        output,
        contains('      levels?.map((e) => e.toJson()).toList(),'),
      );
      expect(
        output,
        contains(
          '      grid.map((e) => e.map((e1) => e1.toJson()).toList()).toList(),',
        ),
      );
    });
  });

  test('never casts to a type that needs converting', () {
    // A cast is only the conversion for a primitive (or `dynamic`).
    final badListCast = RegExp(r'\.cast<(?!(String|int|num|bool|dynamic)\??>)');
    final badCollectionAs = RegExp(
      r'\bas (List<(?!dynamic>)|Map<(?!String, dynamic>))',
    );
    final badClassAs = RegExp(r'\bas (?!(String|List|Map)\b)[A-Z]');
    for (final line in const LineSplitter().convert(output)) {
      if (line.trimLeft().startsWith('//')) continue;
      expect(line, isNot(contains(badListCast)));
      expect(line, isNot(contains(badCollectionAs)));
      expect(line, isNot(contains(badClassAs)));
    }
  });
}
