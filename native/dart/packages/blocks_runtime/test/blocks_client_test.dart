import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/user_agent.dart';
import 'package:test/test.dart';

/// The URL `client.call(method, …)` POSTs to, for a client built on [baseUrl].
Future<String> _requestedUrl(String baseUrl, String method) async {
  Uri? requested;
  final mockClient = MockClient((req) async {
    requested = req.url;
    return http.Response(
      jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
      200,
    );
  });
  await BlocksClient(baseUrl: baseUrl, client: mockClient).call(method, {});
  return requested.toString();
}

void main() {
  group('BlocksClient request URL', () {
    test('posts to the method\'s namespace path', () async {
      expect(
        await _requestedUrl(
          'https://d123.cloudfront.net/aws-blocks/api',
          'reports.build',
        ),
        'https://d123.cloudfront.net/aws-blocks/api/reports',
      );
      expect(
        await _requestedUrl(
          'https://a.example/prod/aws-blocks/api//',
          'reports.build',
        ),
        'https://a.example/prod/aws-blocks/api/reports',
      );
    });

    test('only the first `.` separates the namespace', () async {
      expect(
        await _requestedUrl('https://a.example/aws-blocks/api', 'ns.a.b'),
        'https://a.example/aws-blocks/api/ns',
      );
    });

    test('sends path-safe characters as they are, encodes others', () async {
      expect(
        await _requestedUrl('https://a.example/aws-blocks/api', r'$ns.m'),
        r'https://a.example/aws-blocks/api/$ns',
      );
      expect(
        await _requestedUrl('https://a.example/aws-blocks/api', 'café.m'),
        'https://a.example/aws-blocks/api/caf%C3%A9',
      );
    });

    test('leaves the base URL for a method without namespace', () async {
      expect(
        await _requestedUrl('https://a.example/aws-blocks/api', 'greet'),
        'https://a.example/aws-blocks/api',
      );
      expect(
        await _requestedUrl('https://a.example/aws-blocks/api', '.greet'),
        'https://a.example/aws-blocks/api',
      );
    });
  });

  group('BlocksClient', () {
    test('sends JSON-RPC envelope', () async {
      Map<String, dynamic>? sentBody;
      final mockClient = MockClient((req) async {
        sentBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}),
          200,
        );
      });
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      await client.call('hello.greet', {'name': 'world'});
      expect(sentBody!['jsonrpc'], '2.0');
      expect(sentBody!['method'], 'hello.greet');
      expect(sentBody!['params'], {'name': 'world'});
      expect(sentBody!['id'], isA<int>());
    });

    test('sends x-blocks-user-agent header', () async {
      Map<String, String>? sentHeaders;
      final mockClient = MockClient((req) async {
        sentHeaders = req.headers;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
          200,
        );
      });
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      await client.call('test', {});
      expect(sentHeaders!['x-blocks-user-agent'], blocksUserAgentToken);
    }, testOn: 'vm'); // Web omits the header by design.

    test('throws BlocksRpcException on error response', () async {
      final mockClient = MockClient(
        (_) async => http.Response(
          jsonEncode({
            'jsonrpc': '2.0',
            'error': {'code': -32600, 'message': 'Invalid'},
            'id': 1,
          }),
          200,
        ),
      );
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      expect(
        () => client.call('bad', {}),
        throwsA(
          isA<BlocksRpcException>()
              .having((e) => e.code, 'code', -32600)
              .having((e) => e.message, 'message', 'Invalid'),
        ),
      );
    });

    test('stores cookies via SessionStore', () async {
      final store = InMemorySessionStore();
      final mockClient = MockClient(
        (_) async => http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
          200,
          headers: {'set-cookie': 'session=abc123; Path=/; HttpOnly'},
        ),
      );
      final client = BlocksClient(
        baseUrl: 'http://test',
        client: mockClient,
        sessionStore: store,
      );
      await client.call('test', {});
      expect(store.cookies['session'], 'abc123');
    });

    test('sends cookies on subsequent requests', () async {
      final store = InMemorySessionStore();
      store.setCookies('token=xyz');
      Map<String, String>? sentHeaders;
      final mockClient = MockClient((req) async {
        sentHeaders = req.headers;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}),
          200,
        );
      });
      final client = BlocksClient(
        baseUrl: 'http://test',
        client: mockClient,
        sessionStore: store,
      );
      await client.call('test', {});
      expect(sentHeaders!['cookie'], 'token=xyz');
    });
  });
}
