// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/src/user_agent.dart';
import 'package:blocks_runtime/src/web_socket_pool.dart';
import 'package:test/test.dart';

/// Joins [connection] with a subscriber that is removed on teardown, which
/// closes the socket and stops its keep-alive timer.
void _hold(PooledConnection connection) {
  final subscriber = RealtimeSubscriber(
    channel: 'room',
    onMessage: (_) {},
    onEnd: (_) {},
  );
  connection.subscribe(subscriber, 't');
  addTearDown(() => connection.remove(subscriber));
}

void main() {
  group('WebSocketPool', () {
    test('acquire reuses the connection for the same url', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        final ws = await WebSocketTransformer.upgrade(req);
        addTearDown(ws.close);
      });
      addTearDown(() => server.close(force: true));

      final url = 'ws://127.0.0.1:${server.port}/';
      final pool = WebSocketPool();
      final first = pool.acquire(url);
      _hold(first);
      await first.socket.ready;

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
      final connection = WebSocketPool().acquire(url);
      _hold(connection);
      await connection.socket.ready;

      expect(userAgent, blocksUserAgentToken);
    });
  });
}
