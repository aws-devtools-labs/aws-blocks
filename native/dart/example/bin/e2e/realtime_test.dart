import 'dart:async';
import 'harness.dart';

/// Realtime E2E — native-bindings exposes a single cursor namespace via
/// `realtimeGetChannel({channel})` and `realtimePublish({cursor, channel})`.
/// (The comprehensive backend split these into cursor-specific RPCs;
/// native-bindings uses one channel-parameterised pair.)
void main() async {
  final blocks = createBlocks();

  group('Realtime: get channel descriptor');
  final channel = await blocks.api.realtimeGetChannel();
  check(channel.channel.isNotEmpty, 'channel name: ${channel.channel}');
  check(channel.wsUrl.startsWith('ws'), 'wsUrl starts with ws: ${channel.wsUrl}');
  check(channel.token.isNotEmpty, 'token is not empty');

  group('Realtime: publish cursor');
  final r1 = await blocks.api.realtimePublish(
    cursor: Cursor(userId: 'user-a', x: 10, y: 20, color: '#ff0000'),
  );
  check(r1.success, 'publish success');

  group('Realtime: subscribe and receive');
  final ch = await blocks.api.realtimeGetChannel(channel: 'dart-test');
  final stream = ch.subscribe();
  final completer = Completer<Cursor>();

  final sub = stream.listen((msg) {
    if (!completer.isCompleted) completer.complete(msg);
  });

  await Future.delayed(Duration(milliseconds: 500));

  await blocks.api.realtimePublish(
    channel: 'dart-test',
    cursor: Cursor(userId: 'dart-sub-test', x: 42, y: 99, color: '#00ff00'),
  );

  try {
    final msg = await completer.future.timeout(Duration(seconds: 5));
    check(msg.userId == 'dart-sub-test', 'message userId matches');
    check(msg.x == 42, 'message x matches');
    check(msg.y == 99, 'message y matches');
    check(msg.color == '#00ff00', 'message color matches');
  } on TimeoutException {
    check(false, 'WebSocket message received within 5s (timed out)');
  } finally {
    await sub.cancel();
    ch.close();
  }

  group('Realtime: multiple publishes');
  for (var i = 0; i < 5; i++) {
    final r = await blocks.api.realtimePublish(
      cursor: Cursor(userId: 'burst-$i', x: i, y: i * 10, color: '#000'),
    );
    check(r.success, 'publish #$i success');
  }

  printResults();
}
