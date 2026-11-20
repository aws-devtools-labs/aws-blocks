// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
  check(
    channel.wsUrl.startsWith('ws'),
    'wsUrl starts with ws: ${channel.wsUrl}',
  );
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

  group('Realtime: two subscriptions share one channel handle');
  {
    final shared = await blocks.api.realtimeGetChannel(channel: 'dart-shared');
    final first = Completer<Cursor>();
    final second = Completer<Cursor>();
    final s1 = shared.subscribe().listen((m) {
      if (!first.isCompleted) first.complete(m);
    });
    final s2 = shared.subscribe().listen((m) {
      if (!second.isCompleted) second.complete(m);
    });
    await Future<void>.delayed(Duration(milliseconds: 500));
    await blocks.api.realtimePublish(
      channel: 'dart-shared',
      cursor: Cursor(userId: 'both', x: 1, y: 2, color: '#123456'),
    );
    try {
      final got = await Future.wait([
        first.future,
        second.future,
      ]).timeout(Duration(seconds: 5));
      check(
        got.every((m) => m.userId == 'both'),
        'both subscriptions receive the message',
      );
    } on TimeoutException {
      check(false, 'both subscriptions receive within 5s (timed out)');
    } finally {
      await s1.cancel();
      await s2.cancel();
      shared.close();
    }
  }

  group('Realtime: a refused subscribe ends the stream with a typed error');
  {
    final real = await blocks.api.realtimeGetChannel(channel: 'dart-refused');
    // The same channel with a token the server can't verify, as a handle
    // whose token was tampered with or minted by another backend would be.
    final forged = RealtimeChannel.fromJsonValue({
      '__blocks': 'realtime/channel',
      'channel': real.channel,
      'wsUrl': real.wsUrl,
      'connectToken': real.connectToken,
      'token': 'not-a-valid-token',
    }, (payload) => payload);
    Object? error;
    var done = false;
    try {
      await forged.subscribe().timeout(Duration(seconds: 5)).drain<void>();
      done = true;
    } on RealtimeSubscriptionEndedException catch (e) {
      error = e;
    } on Object catch (e) {
      error = e;
    } finally {
      forged.close();
      real.close();
    }
    check(!done, 'the stream does not end silently');
    check(
      error is RealtimeSubscriptionEndedException,
      'error is RealtimeSubscriptionEndedException: $error',
    );
    if (error is RealtimeSubscriptionEndedException) {
      check(error.channel == real.channel, 'error names the channel');
      check(error.code == null, 'a refused subscribe has no code');
    }
  }

  group('Realtime: close() ends an active stream normally');
  {
    final ch2 = await blocks.api.realtimeGetChannel(channel: 'dart-close');
    final ended = Completer<Object?>();
    ch2.subscribe().listen(
      (_) {},
      onError: (Object e) {
        if (!ended.isCompleted) ended.complete(e);
      },
      onDone: () {
        if (!ended.isCompleted) ended.complete(null);
      },
    );
    await Future<void>.delayed(Duration(milliseconds: 300));
    ch2.close();
    try {
      final result = await ended.future.timeout(Duration(seconds: 5));
      check(result == null, 'stream closes with no error: $result');
    } on TimeoutException {
      check(false, 'stream closes within 5s after close() (timed out)');
    }
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
