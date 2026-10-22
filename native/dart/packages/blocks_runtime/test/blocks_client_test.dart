import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/user_agent.dart';
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

    // The server reads params positionally (an object by its values, in
    // order), so generated clients send an array, as the TypeScript client
    // does, with `null` in a left-out optional's slot.
    test('sends list params as a positional array, null slots kept', () async {
      String? sentRaw;
      final mockClient = MockClient((req) async {
        sentRaw = req.body;
        return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}),
          200,
        );
      });
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      await client.call('api.echoArgs', ['a', null, 'c']);
      final sent = jsonDecode(sentRaw!) as Map<String, dynamic>;
      expect(sent['method'], 'api.echoArgs');
      expect(sent['params'], ['a', null, 'c']);
      expect(sentRaw, contains('"params":["a",null,"c"]'));
    });

    test('resends the same list params after a 401 refresh', () async {
      final sentParams = <Object?>[];
      var calls = 0;
      final mockClient = MockClient((req) async {
        sentParams.add(
          (jsonDecode(req.body) as Map<String, dynamic>)['params'],
        );
        calls++;
        return calls == 1
            ? http.Response('{}', 401)
            : http.Response(
                jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 2}),
                200,
              );
      });
      final client = BlocksClient(
        baseUrl: 'http://test',
        client: mockClient,
        authProvider: _RefreshingAuthProvider(),
      );
      expect(await client.call('api.f', ['x', null, 1]), 'ok');
      expect(sentParams, [
        ['x', null, 1],
        ['x', null, 1],
      ]);
    });

    test('rejects params that are neither a list nor a map', () async {
      var sent = false;
      final mockClient = MockClient((_) async {
        sent = true;
        return http.Response('{}', 200);
      });
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      await expectLater(
        () => client.call('api.f', 'not params'),
        throwsA(isA<ArgumentError>()),
      );
      expect(sent, isFalse);
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

class _RefreshingAuthProvider implements AuthProvider {
  @override
  Future<String?> getAccessToken() async => 'token';

  @override
  Future<void> onAuthFailure() async {}
}
