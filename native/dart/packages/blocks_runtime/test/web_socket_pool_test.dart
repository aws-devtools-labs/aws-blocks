@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/src/user_agent.dart';
import 'package:blocks_runtime/src/web_socket_pool.dart';
import 'package:test/test.dart';

void main() {
  group('WebSocketPool', () {
    test('release is a no-op for an unknown url', () {
      final pool = WebSocketPool();
      pool.release('ws://test');
    });

    test('acquire reuses the channel for the same url', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        final ws = await WebSocketTransformer.upgrade(req);
        addTearDown(ws.close);
      });
      addTearDown(() => server.close(force: true));

      final url = 'ws://127.0.0.1:${server.port}/';
      final pool = WebSocketPool();
      final first = pool.acquire(url);
      await first.ready;
      addTearDown(() => pool.release(url));

      expect(identical(pool.acquire(url), first), isTrue);
      pool.release(url);
      expect(identical(pool.acquire(url), first), isTrue);
    });

    test('sends the user-agent token on the upgrade request', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      String? userAgent;
      server.listen((req) async {
        userAgent = req.headers.value('user-agent');
        final ws = await WebSocketTransformer.upgrade(req);
        addTearDown(ws.close);
      });
      addTearDown(() => server.close(force: true));

      final url = 'ws://127.0.0.1:${server.port}/';
      final pool = WebSocketPool();
      final channel = pool.acquire(url);
      await channel.ready;
      pool.release(url);

      expect(userAgent, blocksUserAgentToken);
    });
  });
}
