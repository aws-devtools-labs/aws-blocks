@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
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
