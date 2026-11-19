// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// Transferables are read-only: the server hands out a realtime channel, a
// file handle or an OIDC client, and nothing sends one back (the server never
// re-hydrates a `{"__blocks": …}` parameter). The runtime classes have no
// `toJson()`, so a method taking one would compile and then always throw on
// the call. Generation refuses such a method instead, naming the method and
// parameter, as the Kotlin generator does. A model holding a transferable is
// refused as a parameter, at any depth, and still generates as a result.

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

Map<String, dynamic> _method(
  String name,
  List<Object> params, {
  Map<String, dynamic> result = const {'type': 'string'},
}) => {
  'name': name,
  'params': params,
  'result': {'name': '${name.split('.').last}Result', 'schema': result},
};

final _channel = _xfer('realtime/channel', [_ref('Note')]);

final _schemas = {
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
      'title': {'type': 'string'},
      'feed': _channel,
    },
    'required': ['title', 'feed'],
  },
  'Outer': {
    'type': 'object',
    'properties': {
      'inner': {'type': 'array', 'items': _ref('Holder')},
    },
    'required': ['inner'],
  },
  'Holder': {
    'type': 'object',
    'properties': {
      'byName': {
        'type': 'object',
        'additionalProperties': _nullable(_xfer('file-bucket/download')),
      },
    },
    'required': ['byName'],
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
  'Plain': {
    'type': 'object',
    'properties': {
      'note': _ref('Note'),
      'tags': {
        'type': 'array',
        'items': {'type': 'string'},
      },
    },
    'required': ['note', 'tags'],
  },
};

String _generate(List<Object> methods) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(
    const OpenRpcParser().parse(
      jsonEncode({
        'openrpc': '1.3.2',
        'info': {'title': 't', 'version': '1'},
        'methods': methods,
        'components': {'schemas': _schemas},
      }),
    ),
  ),
);

Matcher _refused(String message) => throwsA(
  isA<FormatException>().having((e) => e.message, 'message', message),
);

String _error(String tag, String method, String param, [String? field]) =>
    'Transferable types ($tag) cannot be serialized: they are read-only. '
    "Method '$method', parameter '$param'"
    '${field == null ? '' : ' (field $field)'}.';

void main() {
  group('a transferable parameter is refused', () {
    final cases = <String, (Map<String, dynamic>, bool, String)>{
      'direct': (_channel, true, 'realtime/channel'),
      'optional': (_channel, false, 'realtime/channel'),
      'nullable': (_nullable(_channel), true, 'realtime/channel'),
      'in a list': (
        {'type': 'array', 'items': _xfer('file-bucket/upload')},
        true,
        'file-bucket/upload',
      ),
      'in a map': (
        {'type': 'object', 'additionalProperties': _xfer('oidc/client')},
        true,
        'oidc/client',
      ),
      'in a nested list': (
        {
          'type': 'array',
          'items': {'type': 'array', 'items': _xfer('file-bucket/download')},
        },
        false,
        'file-bucket/download',
      ),
      'in a tuple': (
        {
          'type': 'array',
          'prefixItems': [
            {'type': 'string'},
            _xfer('file-bucket/download'),
          ],
          'items': false,
          'minItems': 2,
          'maxItems': 2,
        },
        true,
        'file-bucket/download',
      ),
      'with an unknown tag': (_xfer('custom/thing'), true, 'custom/thing'),
    };
    for (final MapEntry(key: name, value: (schema, required, tag))
        in cases.entries) {
      test(name, () {
        expect(
          () => _generate([
            _method('api.relay', [
              _param('room', {'type': 'string'}),
              _param('feed', schema, required: required),
            ]),
          ]),
          _refused(_error(tag, 'api.relay', 'feed')),
        );
      });
    }
  });

  group('a model holding a transferable is refused as a parameter', () {
    test('a field', () {
      expect(
        () => _generate([
          _method('api.forward', [_param('bundle', _ref('Bundle'))]),
        ]),
        _refused(
          _error('realtime/channel', 'api.forward', 'bundle', 'Bundle.feed'),
        ),
      );
    });

    test('nested in a list of models and a map of nullables', () {
      expect(
        () => _generate([
          _method('api.forward', [
            _param('outer', _nullable(_ref('Outer')), required: false),
          ]),
        ]),
        _refused(
          _error(
            'file-bucket/download',
            'api.forward',
            'outer',
            'Outer.inner.byName',
          ),
        ),
      );
    });

    test('a union arm', () {
      expect(
        () => _generate([
          _method('api.pick', [
            _param('pick', {'type': 'array', 'items': _ref('Pick')}),
          ]),
        ]),
        _refused(
          _error('file-bucket/download', 'api.pick', 'pick', 'Pick.file'),
        ),
      );
    });
  });

  test('every refused parameter is named, one per line', () {
    expect(
      () => _generate([
        _method('api.relay', [_param('feed', _channel)]),
        _method('api.misc', [
          _param('room', {'type': 'string'}),
          _param('bundle', _ref('Bundle')),
          _param('client', _xfer('oidc/client'), required: false),
        ]),
      ]),
      _refused(
        [
          _error('realtime/channel', 'api.relay', 'feed'),
          _error('realtime/channel', 'api.misc', 'bundle', 'Bundle.feed'),
          _error('oidc/client', 'api.misc', 'client'),
        ].join('\n'),
      ),
    );
  });

  test('a transferable result, and a model holding one, still generate', () {
    final output = _generate([
      _method('api.feed', const [], result: _channel),
      _method('api.bundle', const [], result: _ref('Bundle')),
      _method('api.pick', const [], result: _ref('Pick')),
      _method('api.plain', [_param('plain', _ref('Plain'))]),
    ]);
    expect(output, contains('Future<RealtimeChannel<Note>> feed()'));
    expect(output, contains('  final RealtimeChannel<Note> feed;'));
    expect(output, contains('Future<String> plain({required Plain plain})'));
  });
}
