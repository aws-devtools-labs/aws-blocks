import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

void main() {
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

  group('BlocksClient per-namespace request path', () {
    /// Calls one method and returns the URL it was POSTed to.
    Future<Uri> capture(String method, {required String baseUrl}) async {
      Uri? sentUrl;
      final mockClient = MockClient((req) async {
        sentUrl = req.url;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}),
          200,
        );
      });
      final client = BlocksClient(baseUrl: baseUrl, client: mockClient);
      await client.call(method, {});
      return sentUrl!;
    }

    test('appends the namespace as a path segment', () async {
      // A namespace is addressed as `{baseUrl}/{namespace}` so a front door can
      // route it to the compute that hosts it.
      final url = await capture(
        'orders.list',
        baseUrl: 'http://test/aws-blocks/api',
      );
      expect(url.toString(), 'http://test/aws-blocks/api/orders');
    });

    test('routes distinct namespaces to distinct paths', () async {
      final orders = await capture(
        'orders.list',
        baseUrl: 'http://test/aws-blocks/api',
      );
      final auth = await capture(
        'authApi.signIn',
        baseUrl: 'http://test/aws-blocks/api',
      );
      expect(orders, isNot(auth));
      expect(auth.toString(), 'http://test/aws-blocks/api/authApi');
    });

    test('keeps the stage prefix', () async {
      final url = await capture(
        'orders.list',
        baseUrl:
            'https://abc.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api',
      );
      expect(
        url.toString(),
        'https://abc.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api/orders',
      );
    });

    test('tolerates a trailing slash without doubling it', () async {
      final url = await capture(
        'orders.list',
        baseUrl: 'http://test/aws-blocks/api/',
      );
      expect(url.toString(), 'http://test/aws-blocks/api/orders');
    });

    test('uses only the first segment of a dotted method', () async {
      final url = await capture(
        'orders.items.list',
        baseUrl: 'http://test/aws-blocks/api',
      );
      expect(url.toString(), 'http://test/aws-blocks/api/orders');
    });

    test('leaves an un-namespaced method at the base URL', () async {
      // The generator emits a bare method name for un-namespaced operations;
      // there is no segment to add.
      final url = await capture('ping', baseUrl: 'http://test/aws-blocks/api');
      expect(url.toString(), 'http://test/aws-blocks/api');
    });

    test('leaves baseUrl untouched so auth URL derivation still works', () async {
      // OidcClient derives the auth origin from baseUrl by stripping the
      // '/aws-blocks/api' suffix. Appending the namespace to the stored baseUrl
      // would silently defeat that suffix match, so it must stay as configured.
      final client = BlocksClient(
        baseUrl: 'http://test/aws-blocks/api',
        client: MockClient(
          (_) async => http.Response(
            jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}),
            200,
          ),
        ),
      );
      await client.call('orders.list', {});
      expect(client.baseUrl, 'http://test/aws-blocks/api');
    });

    test('keeps the namespace in the request body', () async {
      // The server dispatches on the body, not the path, so the namespace must
      // stay in `method`. Dropping it would break dispatch even though the URL
      // still looks correct.
      Map<String, dynamic>? sentBody;
      final mockClient = MockClient((req) async {
        sentBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}),
          200,
        );
      });
      final client = BlocksClient(
        baseUrl: 'http://test/aws-blocks/api',
        client: mockClient,
      );
      await client.call('orders.list', {});
      expect(sentBody!['method'], 'orders.list');
    });
  });
}
