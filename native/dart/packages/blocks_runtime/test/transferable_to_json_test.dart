import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

// A generated client sends a transferable parameter (or one inside a model)
// as its `{"__blocks": …}` descriptor: the JSON the server sent it as, which
// `toJson()` returns.

final _channel = <String, dynamic>{
  '__blocks': 'realtime/channel',
  'channel': 'room-1',
  'wsUrl': 'wss://example.com/ws',
  'connectToken': 'ct',
  'token': 'sub-token',
};

final _oidc = <String, dynamic>{
  '__blocks': 'oidc/client',
  'providers': ['google'],
  'providerConfigs': {
    'google': {
      'authorizeUrl': 'https://accounts.example.com/authorize',
      'clientId': 'cid',
      'scopes': ['openid', 'email'],
      'kind': 'oidc',
    },
  },
  'exchangePath': '/aws-blocks/auth/exchange',
  'signOutPath': '/aws-blocks/auth/signout',
  'futureKey': {'nested': true},
};

OidcClient _oidcFrom(Map<String, dynamic> descriptor) => OidcClient.fromJson(
  descriptor,
  baseUrl: 'https://api.example.com/aws-blocks/api',
  tokenStore: InMemoryTokenStore(),
);

void main() {
  group('RealtimeChannel.toJson', () {
    test('returns the descriptor it was hydrated from', () {
      final channel = RealtimeChannel.fromJson(_channel, (json) => json);
      expect(channel.toJson(), _channel);
      expect(jsonEncode(channel.toJson()), jsonEncode(_channel));
    });

    test('keeps a descriptor with no connect token as it was', () {
      final descriptor = Map.of(_channel)..remove('connectToken');
      final channel = RealtimeChannel.fromJsonValue(descriptor, (p) => p);
      expect(jsonEncode(channel.toJson()), jsonEncode(descriptor));
    });

    test('carries the tag when the descriptor had none', () {
      final descriptor = Map.of(_channel)..remove('__blocks');
      final channel = RealtimeChannel.fromJson(descriptor, (json) => json);
      expect(channel.toJson(), _channel);
    });

    test('is what jsonEncode writes for the channel', () {
      final channel = RealtimeChannel.fromJson(_channel, (json) => json);
      expect(jsonEncode({'feed': channel}), jsonEncode({'feed': _channel}));
    });

    test("returns a copy: changing it doesn't change the channel", () {
      final channel = RealtimeChannel.fromJson(_channel, (json) => json);
      channel.toJson()['token'] = 'changed';
      expect(channel.toJson(), _channel);
    });
  });

  group('file handles', () {
    test('FileDownloadHandle.toJson returns its descriptor', () {
      final descriptor = {
        '__blocks': 'file-bucket/download',
        'url': 'https://bucket.example.com/a?sig=1',
      };
      final handle = FileDownloadHandle.fromJson(descriptor);
      expect(jsonEncode(handle.toJson()), jsonEncode(descriptor));
      expect(jsonEncode([handle]), jsonEncode([descriptor]));
    });

    test('FileUploadHandle.toJson returns its descriptor', () {
      for (final descriptor in [
        {
          '__blocks': 'file-bucket/upload',
          'url': 'https://bucket.example.com/b?sig=2',
          'contentType': 'image/png',
        },
        {
          '__blocks': 'file-bucket/upload',
          'url': 'https://bucket.example.com/b?sig=2',
        },
      ]) {
        final handle = FileUploadHandle.fromJson(descriptor);
        expect(jsonEncode(handle.toJson()), jsonEncode(descriptor));
      }
    });

    test('a handle hydrated from an untagged descriptor carries the tag', () {
      expect(FileDownloadHandle.fromJson({'url': 'u'}).toJson(), {
        '__blocks': 'file-bucket/download',
        'url': 'u',
      });
      expect(FileUploadHandle.fromJson({'url': 'u'}).toJson(), {
        '__blocks': 'file-bucket/upload',
        'url': 'u',
      });
    });
  });

  group('OidcClient.toJson', () {
    test('returns the descriptor it was hydrated from, unknown keys too', () {
      final client = _oidcFrom(_oidc);
      expect(jsonEncode(client.toJson()), jsonEncode(_oidc));
    });

    test('a client built with the constructor describes its fields', () {
      final client = OidcClient(
        exchangePath: '/x/exchange',
        refreshPath: '/x/exchange/refresh',
        signOutPath: '/x/signout',
        providers: ['github'],
        providerConfigs: {
          'github': const ProviderConfig(
            authorizeUrl: 'https://github.example.com/authorize',
            clientId: 'gh',
            scopes: ['read:user'],
            kind: 'oauth',
          ),
        },
        baseUrl: 'https://api.example.com/aws-blocks/api',
        tokenStore: InMemoryTokenStore(),
      );
      expect(client.toJson(), {
        '__blocks': 'oidc/client',
        'providers': ['github'],
        'providerConfigs': {
          'github': {
            'authorizeUrl': 'https://github.example.com/authorize',
            'clientId': 'gh',
            'scopes': ['read:user'],
            'kind': 'oauth',
          },
        },
        'exchangePath': '/x/exchange',
        'refreshPath': '/x/exchange/refresh',
        'signOutPath': '/x/signout',
        'authorizeParamsBasePath': OidcClient.defaultAuthorizeParamsBasePath,
        'callbackPath': OidcClient.defaultCallbackPath,
      });
      final copy = _oidcFrom(client.toJson());
      expect(copy.exchangePath, client.exchangePath);
      expect(copy.refreshPath, client.refreshPath);
      expect(copy.signOutPath, client.signOutPath);
      expect(copy.providers, client.providers);
      expect(copy.providerConfigs['github']!.clientId, 'gh');
      expect(copy.authorizeParamsBasePath, client.authorizeParamsBasePath);
      expect(copy.callbackPath, client.callbackPath);
    });

    test("returns a copy: changing it doesn't change the client", () {
      final client = _oidcFrom(_oidc);
      client.toJson()['exchangePath'] = '/changed';
      expect(jsonEncode(client.toJson()), jsonEncode(_oidc));
    });
  });

  test('UnknownTransferable.toJson returns its descriptor', () {
    final descriptor = {'__blocks': 'custom/thing', 'id': 7};
    final value = UnknownTransferable.fromJson(
      descriptor,
      expectedTag: 'custom/thing',
    );
    expect(jsonEncode(value.toJson()), jsonEncode(descriptor));
    expect(jsonEncode({'v': value}), jsonEncode({'v': descriptor}));
  });
}
