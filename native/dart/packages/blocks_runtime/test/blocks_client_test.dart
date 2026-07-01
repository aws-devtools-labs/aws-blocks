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
            jsonEncode({'jsonrpc': '2.0', 'result': 'ok', 'id': 1}), 200);
      });
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      await client.call('hello.greet', {'name': 'world'});
      expect(sentBody!['jsonrpc'], '2.0');
      expect(sentBody!['method'], 'hello.greet');
      expect(sentBody!['params'], {'name': 'world'});
      expect(sentBody!['id'], isA<int>());
    });

    test('throws BlocksRpcException on error response', () async {
      final mockClient = MockClient((_) async => http.Response(
          jsonEncode({
            'jsonrpc': '2.0',
            'error': {'code': -32600, 'message': 'Invalid'},
            'id': 1
          }),
          200));
      final client = BlocksClient(baseUrl: 'http://test', client: mockClient);
      expect(
        () => client.call('bad', {}),
        throwsA(isA<BlocksRpcException>()
            .having((e) => e.code, 'code', -32600)
            .having((e) => e.message, 'message', 'Invalid')),
      );
    });

    test('stores cookies via SessionStore', () async {
      final store = InMemorySessionStore();
      final mockClient = MockClient((_) async => http.Response(
          jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}), 200,
          headers: {'set-cookie': 'session=abc123; Path=/; HttpOnly'}));
      final client = BlocksClient(
          baseUrl: 'http://test', client: mockClient, sessionStore: store);
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
            jsonEncode({'jsonrpc': '2.0', 'result': null, 'id': 1}), 200);
      });
      final client = BlocksClient(
          baseUrl: 'http://test', client: mockClient, sessionStore: store);
      await client.call('test', {});
      expect(sentHeaders!['cookie'], 'token=xyz');
    });
  });
}
