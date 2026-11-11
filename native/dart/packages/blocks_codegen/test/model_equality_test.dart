import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// A generated model's `==` and `hashCode` used to compare list and map fields
// with `==` and `hashCode`, which Dart's `List` and `Map` implement by
// identity. So two models decoded from the same JSON weren't equal as soon as
// they had a list or map field. Those fields now go through the runtime's
// `blocksDeepEquals` / `blocksDeepHash`; every other field is unchanged.
//
// And the generated library only re-exported `RealtimeChannel`, the file
// handles and `OidcClient` when one was a top-level type or a direct
// operation result, so a client couldn't name the type of a transferable
// nested in a model, a list or a parameter without importing blocks_runtime.

const _note = {r'$ref': '#/components/schemas/Note'};

Map<String, dynamic> _list(Map<String, dynamic> items) => {
  'type': 'array',
  'items': items,
};

Map<String, dynamic> _map(Map<String, dynamic> values) => {
  'type': 'object',
  'additionalProperties': values,
};

Map<String, dynamic> _nullable(Map<String, dynamic> inner) => {
  'oneOf': [
    inner,
    {'type': 'null'},
  ],
};

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

String _spec(
  List<Map<String, dynamic>> methods,
  Map<String, dynamic> schemas,
) => jsonEncode({
  'openrpc': '1.3.2',
  'info': {'title': 'test', 'version': '1.0.0'},
  'methods': methods,
  'components': {'schemas': schemas},
});

String _generate(String spec) => const DartCodeGenerator().generate(
  CodegenModelBuilder().build(const OpenRpcParser().parse(spec)),
);

const _noteSchema = {
  'type': 'object',
  'properties': {
    'id': {'type': 'string'},
  },
  'required': ['id'],
};

const _realtimeExport =
    "export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;";
const _oidcExport =
    "export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;";

void main() {
  group('== and hashCode compare list and map fields deeply', () {
    final output = _generate(
      _spec(
        [
          _method('getLayout', {r'$ref': '#/components/schemas/Layout'}),
          _method('getTags', {r'$ref': '#/components/schemas/Tags'}),
          _method('getPlain', {r'$ref': '#/components/schemas/Plain'}),
          _method('getShape', {r'$ref': '#/components/schemas/Shape'}),
        ],
        {
          'Note': _noteSchema,
          'Layout': {
            'type': 'object',
            'properties': {
              'title': {'type': 'string'},
              'tags': _list({'type': 'string'}),
              'notesByTag': _map(_list(_note)),
              'grid': _list(_list(_note)),
              'maybeScores': _nullable(_list({'type': 'integer'})),
              'pinned': _note,
              'extra': {'type': 'unknown'},
            },
            'required': ['title', 'tags', 'notesByTag', 'grid', 'pinned'],
          },
          'Tags': {
            'type': 'object',
            'properties': {
              'values': _list({'type': 'string'}),
            },
            'required': ['values'],
          },
          'Plain': {
            'type': 'object',
            'properties': {
              'name': {'type': 'string'},
            },
            'required': ['name'],
            'additionalProperties': _note,
          },
          'Shape': {
            'oneOf': [
              {
                'type': 'object',
                'properties': {
                  'kind': {
                    'type': 'string',
                    'enum': ['polygon'],
                  },
                  'points': _list({'type': 'number'}),
                  'label': {'type': 'string'},
                },
                'required': ['kind', 'points', 'label'],
              },
              {
                'type': 'object',
                'properties': {
                  'kind': {
                    'type': 'string',
                    'enum': ['dot'],
                  },
                  'label': {'type': 'string'},
                },
                'required': ['kind', 'label'],
              },
            ],
          },
        },
      ),
    );

    test('lists, maps and unknown (`dynamic`) values use deep equality', () {
      expect(
        output,
        contains(
          '      other is Layout &&\n'
          '          title == other.title &&\n'
          '          blocksDeepEquals(tags, other.tags) &&\n'
          '          blocksDeepEquals(notesByTag, other.notesByTag) &&\n'
          '          blocksDeepEquals(grid, other.grid) &&\n'
          '          blocksDeepEquals(maybeScores, other.maybeScores) &&\n'
          '          pinned == other.pinned &&\n'
          '          blocksDeepEquals(extra, other.extra);',
        ),
      );
    });

    test('hashCode hashes the same fields deeply, so it agrees with ==', () {
      expect(
        output,
        contains(
          '  int get hashCode => Object.hash(title, blocksDeepHash(tags), blocksDeepHash(notesByTag), blocksDeepHash(grid), blocksDeepHash(maybeScores), pinned, blocksDeepHash(extra));',
        ),
      );
    });

    test('a model with one list field hashes it deeply', () {
      expect(
        output,
        contains('          blocksDeepEquals(values, other.values);'),
      );
      expect(output, contains('  int get hashCode => blocksDeepHash(values);'));
    });

    test('additional properties compare deeply', () {
      expect(
        output,
        contains(
          '          name == other.name &&\n'
          '          blocksDeepEquals(additionalProperties, other.additionalProperties);',
        ),
      );
      expect(
        output,
        contains(
          '  int get hashCode => Object.hash(name, blocksDeepHash(additionalProperties));',
        ),
      );
    });

    test('a sealed variant compares its list fields deeply', () {
      expect(
        output,
        contains(
          '      other is PolygonShape &&\n'
          '          blocksDeepEquals(points, other.points) &&\n'
          '          label == other.label;',
        ),
      );
      expect(
        output,
        contains(
          '  int get hashCode => Object.hash(blocksDeepHash(points), label);',
        ),
      );
    });

    test('a model with no list or map field is unchanged', () {
      expect(
        output,
        contains(
          '      other is Note &&\n'
          '          id == other.id;',
        ),
      );
      expect(output, contains('  int get hashCode => id.hashCode;'));
      expect(
        output,
        contains(
          '      other is DotShape &&\n'
          '          label == other.label;',
        ),
      );
    });
  });

  group('nested transferable types are re-exported', () {
    test('a realtime channel held only by a model field', () {
      final output = _generate(
        _spec(
          [
            _method('getRoom', {r'$ref': '#/components/schemas/Room'}),
          ],
          {
            'Note': _noteSchema,
            'Room': {
              'type': 'object',
              'properties': {
                'feed': {
                  'x-blocks-transferable': 'realtime/channel',
                  'x-blocks-type-args': [_note],
                },
              },
              'required': ['feed'],
            },
          },
        ),
      );
      expect(output, contains('  final RealtimeChannel<Note> feed;'));
      expect(output, contains(_realtimeExport));
      expect(output, isNot(contains(_oidcExport)));
    });

    test('a file handle in a list inside a model', () {
      final output = _generate(
        _spec(
          [
            _method('getAlbum', {r'$ref': '#/components/schemas/Album'}),
          ],
          {
            'Album': {
              'type': 'object',
              'properties': {
                'photos': _list({
                  'x-blocks-transferable': 'file-bucket/download',
                }),
              },
              'required': ['photos'],
            },
          },
        ),
      );
      expect(output, contains('  final List<FileDownloadHandle> photos;'));
      expect(output, contains(_realtimeExport));
    });

    test('a list of channels as an operation result', () {
      final output = _generate(
        _spec(
          [
            _method(
              'listFeeds',
              _list({
                'x-blocks-transferable': 'realtime/channel',
                'x-blocks-type-args': [_note],
              }),
            ),
          ],
          {'Note': _noteSchema},
        ),
      );
      expect(output, contains('Future<List<RealtimeChannel<Note>>> listFeeds'));
      expect(output, contains(_realtimeExport));
    });

    test('a file upload handle in a list parameter', () {
      final output = _generate(
        _spec([
          _method(
            'ping',
            {'type': 'string'},
            [
              {
                'name': 'uploads',
                'required': true,
                'schema': _list({
                  'x-blocks-transferable': 'file-bucket/upload',
                }),
              },
            ],
          ),
        ], {}),
      );
      expect(output, contains('List<FileUploadHandle> uploads'));
      expect(output, contains(_realtimeExport));
    });

    test('an oidc client held by a model two levels down', () {
      final output = _generate(
        _spec(
          [
            _method('getMenu', {r'$ref': '#/components/schemas/Menu'}),
          ],
          {
            'Option': {
              'type': 'object',
              'properties': {
                'client': {'x-blocks-transferable': 'oidc/client'},
              },
              'required': ['client'],
            },
            'Menu': {
              'type': 'object',
              'properties': {
                'options': _list({r'$ref': '#/components/schemas/Option'}),
              },
              'required': ['options'],
            },
          },
        ),
      );
      expect(output, contains('  final OidcClient client;'));
      expect(output, contains(_oidcExport));
      expect(output, contains(_realtimeExport));
    });

    test('a client with no transferables exports neither', () {
      final output = _generate(
        _spec([_method('getNote', _note)], {'Note': _noteSchema}),
      );
      expect(output, isNot(contains(_realtimeExport)));
      expect(output, isNot(contains(_oidcExport)));
    });
  });
}
