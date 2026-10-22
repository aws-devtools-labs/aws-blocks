import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// A transferable (a realtime channel, a file handle, an OIDC client) passed
// back to the server as a parameter, or inside a model the client sends,
// used to be put in the request as the runtime object itself
// (`'feed': feed`). The runtime classes had no `toJson()`, so `jsonEncode`
// threw. It is now sent as its `{"__blocks": …}` descriptor, the shape the
// server sent it in, at any depth, as Kotlin and Swift send it.

Map<String, dynamic> _xfer(String tag, [List<Object>? typeArgs]) => {
  'x-blocks-transferable': tag,
  'x-blocks-type-args': ?typeArgs,
};

Map<String, dynamic> _ref(String name) => {
  r'$ref': '#/components/schemas/$name',
};

Map<String, dynamic> _nullable(Map<String, dynamic> schema) => {
  'oneOf': [
    schema,
    {'type': 'null'},
  ],
};

Map<String, dynamic> _param(
  String name,
  Map<String, dynamic> schema, {
  bool required = true,
}) => {'name': name, 'required': required, 'schema': schema};

Map<String, dynamic> _method(String name, List<Object> params) => {
  'name': name,
  'params': params,
  'result': {
    'name': '${name.split('.').last}Result',
    'schema': {'type': 'string'},
  },
};

final _channel = _xfer('realtime/channel', [_ref('Note')]);

final _spec = jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 't', 'version': '1'},
  'methods': [
    _method('api.relay', [
      _param('feed', _channel),
      _param('maybe', _channel, required: false),
      _param('orNull', _nullable(_channel)),
      _param('feeds', {'type': 'array', 'items': _channel}),
      _param('byRoom', {'type': 'object', 'additionalProperties': _channel}),
    ]),
    _method('api.share', [
      _param('download', _xfer('file-bucket/download')),
      _param('upload', _xfer('file-bucket/upload')),
      _param('bundle', _ref('Bundle')),
    ]),
    _method('api.useOidc', [
      _param('client', _xfer('oidc/client')),
      _param('clients', {
        'type': 'array',
        'items': _xfer('oidc/client'),
      }, required: false),
      _param('holder', _ref('Holder')),
    ]),
    _method('api.misc', [
      _param('pair', {
        'type': 'array',
        'prefixItems': [
          _xfer('file-bucket/download'),
          {'type': 'string'},
        ],
        'items': false,
        'minItems': 2,
        'maxItems': 2,
      }),
      _param('maybeMap', {
        'type': 'object',
        'additionalProperties': _nullable(_xfer('file-bucket/upload')),
      }, required: false),
      _param('nested', {
        'type': 'array',
        'items': {'type': 'array', 'items': _xfer('file-bucket/download')},
      }),
      _param('pick', _ref('Pick')),
      _param('other', _xfer('custom/thing')),
    ]),
  ],
  'components': {
    'schemas': {
      'Note': {
        'type': 'object',
        'properties': {
          'text': {'type': 'string'},
        },
        'required': ['text'],
      },
      'Bundle': {
        'type': 'object',
        'properties': {
          'feed': _channel,
          'files': {'type': 'array', 'items': _xfer('file-bucket/download')},
          'upload': _xfer('file-bucket/upload'),
        },
        'required': ['feed', 'files'],
      },
      'Holder': {
        'type': 'object',
        'properties': {
          'client': _xfer('oidc/client'),
          'maybe': _nullable(_xfer('file-bucket/download')),
          'byName': {
            'type': 'object',
            'additionalProperties': _xfer('file-bucket/download'),
          },
        },
        'required': ['client', 'maybe', 'byName'],
      },
      'Pick': {
        'oneOf': [
          {
            'type': 'object',
            'properties': {
              'kind': {
                'type': 'string',
                'enum': ['file'],
              },
              'file': _xfer('file-bucket/download'),
            },
            'required': ['kind', 'file'],
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

  /// From [start] to the end of its method, or of its class when [start]
  /// opens one.
  String section(String start) {
    final i = output.indexOf(start);
    expect(i, isNot(-1), reason: 'missing `$start`');
    final end = start.startsWith('class ') ? '\n}\n' : '\n  }\n';
    return output.substring(i, output.indexOf(end, i));
  }

  group('an operation parameter', () {
    test('a channel, direct, optional, nullable, in a list and a map', () {
      expect(
        section('Future<String> relay('),
        contains(
          '      feed.toJson(),\n'
          '      maybe?.toJson(),\n'
          '      orNull?.toJson(),\n'
          '      feeds.map((e) => e.toJson()).toList(),\n'
          '      byRoom.map((k, v) => MapEntry(k, v.toJson())),\n',
        ),
      );
    });

    test('file handles, and a model holding transferables', () {
      expect(
        section('Future<String> share('),
        contains(
          '      download.toJson(),\n'
          '      upload.toJson(),\n'
          '      bundle.toJson(),\n',
        ),
      );
    });

    test('an OIDC client, direct, in a list, and in a model', () {
      expect(
        section('Future<String> useOidc('),
        contains(
          '      client.toJson(),\n'
          '      clients?.map((e) => e.toJson()).toList(),\n'
          '      holder.toJson(),\n',
        ),
      );
    });

    test('in a tuple, a map of nullables and a nested list', () {
      expect(
        section('Future<String> misc('),
        contains(
          '      [pair.\$1.toJson(), pair.\$2],\n'
          '      maybeMap?.map((k, v) => MapEntry(k, v?.toJson())),\n'
          '      nested.map((e) => e.map((e1) => e1.toJson()).toList()).toList(),\n'
          '      pick.toJson(),\n',
        ),
      );
    });

    test('a transferable with no runtime binding is sent as is', () {
      // Typed `dynamic`: it holds the descriptor JSON the server sent.
      expect(
        section('Future<String> misc('),
        contains('required dynamic other'),
      );
      expect(section('Future<String> misc('), contains('      other,\n'));
    });
  });

  group("a model's toJson", () {
    test('encodes a channel, a list of handles and an optional handle', () {
      expect(
        section('class Bundle {'),
        contains(
          "      'feed': feed.toJson(),\n"
          "      'files': files.map((e) => e.toJson()).toList(),\n"
          "      if (upload != null) 'upload': upload?.toJson(),\n",
        ),
      );
    });

    test('encodes an OIDC client, a nullable handle and a map of handles', () {
      expect(
        section('class Holder {'),
        contains(
          "      'client': client.toJson(),\n"
          "      'maybe': maybe?.toJson(),\n"
          "      'byName': byName.map((k, v) => MapEntry(k, v.toJson())),\n",
        ),
      );
    });

    test('encodes a handle in a union variant', () {
      expect(
        section('class FilePick extends Pick {'),
        contains(
          "      'kind': 'file',\n"
          "      'file': file.toJson(),\n",
        ),
      );
    });
  });

  test('no transferable is put in a request or a model as the object', () {
    for (final name in [
      'feed',
      'maybe',
      'orNull',
      'feeds',
      'byRoom',
      'download',
      'upload',
      'client',
      'clients',
      'files',
      'byName',
      'file',
      'nested',
    ]) {
      expect(output, isNot(contains("'$name': $name,")), reason: name);
      expect(output, isNot(contains("'$name': $name\n")), reason: name);
    }
  });
}
