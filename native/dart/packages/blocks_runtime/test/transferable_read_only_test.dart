import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

// Transferables are read-only: the server hands them out and nothing sends
// one back, so they have no `toJson()` and `jsonEncode` refuses them. A
// generated client passes one through as the object, so sending it fails
// here instead of reaching a server that can't re-hydrate it.
void main() {
  final transferables = <String, Object>{
    'RealtimeChannel': RealtimeChannel.fromJson({
      '__blocks': 'realtime/channel',
      'channel': 'c',
      'wsUrl': 'wss://example.com',
      'token': 't',
    }, (json) => json),
    'FileDownloadHandle': FileDownloadHandle.fromJson({
      '__blocks': 'file-bucket/download',
      'url': 'https://example.com/f',
    }),
    'FileUploadHandle': FileUploadHandle.fromJson({
      '__blocks': 'file-bucket/upload',
      'url': 'https://example.com/f',
    }),
    'OidcClient': OidcClient.fromJson(
      {
        '__blocks': 'oidc/client',
        'providers': ['google'],
        'providerConfigs': <String, dynamic>{},
        'exchangePath': '/aws-blocks/auth/exchange',
        'signOutPath': '/aws-blocks/auth/signout',
      },
      baseUrl: 'https://example.com',
      tokenStore: InMemoryTokenStore(),
    ),
    'UnknownTransferable': UnknownTransferable.fromJson({
      '__blocks': 'acme/widget',
    }, expectedTag: 'acme/widget'),
  };

  for (final MapEntry(key: name, value: transferable)
      in transferables.entries) {
    test('$name cannot be encoded', () {
      expect(
        () => jsonEncode({'value': transferable}),
        throwsA(isA<JsonUnsupportedObjectError>()),
      );
    });
  }
}
