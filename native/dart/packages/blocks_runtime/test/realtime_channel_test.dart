// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/web_socket_pool.dart';
import 'package:test/test.dart';

/// A local WebSocket server that answers each `subscribe` with one `message`
/// frame per entry in [frames] (each merged with the subscribed channel name).
Future<String> _serve(List<Map<String, Object?>> frames) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  addTearDown(() => server.close(force: true));
  server.listen((req) async {
    final ws = await WebSocketTransformer.upgrade(req);
    addTearDown(ws.close);
    ws.listen((data) {
      final msg = jsonDecode(data as String) as Map<String, dynamic>;
      if (msg['action'] != 'subscribe') return;
      for (final frame in frames) {
        ws.add(
          jsonEncode({'type': 'message', 'channel': msg['channel'], ...frame}),
        );
      }
    });
  });
  return 'ws://127.0.0.1:${server.port}/';
}

Map<String, dynamic> _descriptor(String wsUrl) => {
  '__blocks': 'realtime/channel',
  'channel': 'room',
  'wsUrl': wsUrl,
  'token': 't',
};

void main() {
  group('RealtimeChannel', () {
    test(
      'fromJson decodes object payloads with the map deserializer',
      () async {
        final url = await _serve([
          {
            'data': {'text': 'aws'},
          },
          {
            'payload': {'text': 'mock'},
          },
        ]);
        final channel = RealtimeChannel.fromJson(
          _descriptor(url),
          (json) => json['text'] as String,
        );
        addTearDown(channel.close);

        expect(await channel.subscribe().take(2).toList(), ['aws', 'mock']);
      },
    );

    test('fromJsonValue decodes non-object payloads', () async {
      // A channel's message type can be any JSON value (here an array); the
      // map-only fromJson deserializer cannot receive it.
      final url = await _serve([
        {
          'data': ['a', 'b'],
        },
        {
          'payload': ['c'],
        },
      ]);
      final channel = RealtimeChannel.fromJsonValue(
        _descriptor(url),
        (payload) => (payload as List<dynamic>).cast<String>(),
      );
      addTearDown(channel.close);

      expect(channel, isA<RealtimeChannel<List<String>>>());
      expect(await channel.subscribe().take(2).toList(), [
        ['a', 'b'],
        ['c'],
      ]);
    });

    test('a payload that fails to decode ends the stream', () async {
      final url = await _serve([
        {
          'data': {'count': 1},
        },
        {
          'data': {'text': 'ok'},
        },
      ]);
      final channel = RealtimeChannel.fromJson(
        _descriptor(url),
        (json) => json['text'] as String,
      );
      addTearDown(channel.close);

      final events = <Object>[];
      await channel.subscribe().handleError(events.add).forEach(events.add);
      expect(events, [isA<TypeError>()]);
    });

    test(
      'a refused subscribe ends the stream with SubscriptionEnded',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        server.listen((req) async {
          final ws = await WebSocketTransformer.upgrade(req);
          addTearDown(ws.close);
          ws.listen((data) {
            final msg = jsonDecode(data as String) as Map<String, dynamic>;
            ws.add(
              jsonEncode({
                'type': 'error',
                'channel': msg['channel'],
                'message': 'Unauthorized: invalid or expired token',
              }),
            );
          });
        });
        final channel = RealtimeChannel.fromJsonValue(
          _descriptor('ws://127.0.0.1:${server.port}/'),
          (payload) => payload,
        );
        addTearDown(channel.close);

        final errors = <Object>[];
        await channel.subscribe().handleError(errors.add).drain<void>();
        expect(errors, [
          isA<RealtimeSubscriptionEndedException>()
              .having((e) => e.channel, 'channel', 'room')
              .having((e) => e.code, 'code', isNull),
        ]);
      },
    );

    test(
      'a server close ends the stream with RealtimeConnectionException',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        server.listen((req) async {
          final ws = await WebSocketTransformer.upgrade(req);
          ws.listen((_) => ws.close(1001, 'Going away'));
        });
        final channel = RealtimeChannel.fromJsonValue(
          _descriptor('ws://127.0.0.1:${server.port}/'),
          (payload) => payload,
        );
        addTearDown(channel.close);

        final errors = <Object>[];
        await channel.subscribe().handleError(errors.add).drain<void>();
        expect(errors, [
          isA<RealtimeConnectionException>().having(
            (e) => e.message,
            'message',
            contains('1001'),
          ),
        ]);
      },
    );

    test(
      'a server that never answers the upgrade times out and is released',
      () async {
        // Accepts TCP and reads the upgrade request, but never replies.
        final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(server.close);
        final released = Completer<void>();
        server.listen((socket) {
          addTearDown(socket.destroy);
          socket.listen(
            (_) {},
            onDone: () => released.complete(),
            onError: (Object _) => released.complete(),
          );
        });
        final previous = WebSocketPool.shared;
        WebSocketPool.shared = WebSocketPool(
          handshakeTimeout: const Duration(milliseconds: 300),
        );
        addTearDown(() => WebSocketPool.shared = previous);
        final channel = RealtimeChannel.fromJsonValue(
          _descriptor('ws://127.0.0.1:${server.port}/'),
          (payload) => payload,
        );
        addTearDown(channel.close);

        final errors = <Object>[];
        await channel
            .subscribe()
            .handleError(errors.add)
            .drain<void>()
            .timeout(const Duration(seconds: 5));
        expect(errors, [isA<RealtimeConnectionException>()]);
        // The client dropped the pending connection.
        await released.future.timeout(const Duration(seconds: 5));
      },
    );

    test('fromJsonValue hydrates the descriptor fields', () {
      final channel = RealtimeChannel.fromJsonValue({
        ..._descriptor('ws://h/'),
        'connectToken': 'ct',
      }, (payload) => payload);
      expect(channel.channel, 'room');
      expect(channel.wsUrl, 'ws://h/');
      expect(channel.connectToken, 'ct');
      expect(channel.token, 't');
    });
  });
}
