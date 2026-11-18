@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

/// A loopback port that refuses connections: bound, then closed.
Future<int> _refusedPort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

void main() {
  test('connection refused, through the real HTTP client', () async {
    final port = await _refusedPort();
    final client = BlocksClient(
      baseUrl: 'http://127.0.0.1:$port/aws-blocks/api',
    );
    addTearDown(client.close);
    await expectLater(
      client.call('ns.method', []),
      throwsA(
        isA<TransportException>()
            .having((e) => e.statusCode, 'statusCode', isNull)
            .having((e) => e.cause, 'cause', isNotNull),
      ),
    );
  });

  test('HTTP 503 with an HTML body, from a real server', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      await request.drain<void>();
      request.response
        ..statusCode = 503
        ..headers.contentType = ContentType.html
        ..write('<html><body>Service Unavailable</body></html>');
      await request.response.close();
    });
    final client = BlocksClient(
      baseUrl: 'http://127.0.0.1:${server.port}/aws-blocks/api',
    );
    addTearDown(client.close);
    await expectLater(
      client.call('ns.method', []),
      throwsA(
        isA<TransportException>().having(
          (e) => e.statusCode,
          'statusCode',
          503,
        ),
      ),
    );
  });

  test(
    'a realtime connection failure is a RealtimeConnectionException',
    () async {
      final port = await _refusedPort();
      final channel = RealtimeChannel.fromJsonValue({
        '__blocks': 'realtime/channel',
        'channel': 'room',
        'wsUrl': 'ws://127.0.0.1:$port/',
        'token': 't',
      }, (payload) => payload);
      addTearDown(channel.close);

      final errors = <Object>[];
      await channel.subscribe().handleError(errors.add).drain<void>();
      expect(errors, [
        isA<RealtimeConnectionException>()
            .having((e) => e.cause, 'cause', isNotNull)
            .having((e) => e.message, 'message', 'Realtime connection failed'),
      ]);
    },
  );

  test('an OIDC response cut off mid-body is a TransportException', () async {
    // Raw sockets: send headers promising a body, then drop the connection.
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    server.listen((socket) async {
      await socket.first;
      socket.write(
        'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n'
        'content-length: 100\r\n\r\n{"user":',
      );
      await socket.flush();
      socket.destroy();
    });
    final client = OidcClient(
      exchangePath: '/aws-blocks/auth/exchange',
      refreshPath: '/aws-blocks/auth/refresh',
      signOutPath: '/aws-blocks/auth/signout',
      providers: ['google'],
      providerConfigs: {},
      baseUrl: 'http://127.0.0.1:${server.port}/aws-blocks/api',
      tokenStore: InMemoryTokenStore(),
    );
    await expectLater(
      client.restore(),
      throwsA(
        isA<TransportException>()
            .having((e) => e.statusCode, 'statusCode', isNull)
            .having((e) => e.cause, 'cause', isA<Exception>()),
      ),
    );
  });
}
