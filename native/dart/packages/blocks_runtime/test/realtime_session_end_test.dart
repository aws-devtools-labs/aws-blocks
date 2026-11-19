// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:blocks_runtime/src/web_socket_pool.dart';
import 'package:fake_async/fake_async.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:test/test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// A WebSocket the test plays the server side of.
class FakeSocket with StreamChannelMixin<dynamic> implements WebSocketChannel {
  FakeSocket(this.uri, {this.handshakeDone = true});

  /// Whether `ready` completes. A socket whose server never answers the
  /// upgrade leaves it pending.
  final bool handshakeDone;

  final Uri uri;
  final _incoming = StreamController<dynamic>();

  /// Every frame the client sent, decoded.
  final sent = <Map<String, dynamic>>[];
  bool clientClosed = false;

  @override
  int? closeCode;
  @override
  String? closeReason;

  @override
  late final WebSocketSink sink = _FakeSink(this);
  @override
  Stream<dynamic> get stream => _incoming.stream;
  @override
  String? get protocol => null;
  @override
  Future<void> get ready =>
      handshakeDone ? Future.value() : Completer<void>().future;

  void send(Map<String, Object?> frame) => _incoming.add(jsonEncode(frame));
  void sendRaw(Object data) => _incoming.add(data);

  void close([int? code, String? reason]) {
    closeCode = code;
    closeReason = reason;
    _incoming.close();
  }

  void fail(Object error) {
    _incoming.addError(error);
    _incoming.close();
  }

  List<Map<String, dynamic>> get pings =>
      sent.where((f) => f['action'] == 'ping').toList();

  List<Map<String, dynamic>> get unsubscribes =>
      sent.where((f) => f['action'] == 'unsubscribe').toList();
}

class _FakeSink implements WebSocketSink {
  _FakeSink(this._socket);
  final FakeSocket _socket;

  @override
  void add(dynamic data) =>
      _socket.sent.add(jsonDecode(data as String) as Map<String, dynamic>);
  @override
  void addError(Object error, [StackTrace? stackTrace]) {}
  @override
  Future<void> addStream(Stream<dynamic> stream) => stream.forEach(add);
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    _socket.clientClosed = true;
  }

  @override
  Future<void> get done => Future.value();
}

/// A message on the stream, or how it ended.
sealed class _Event {}

class _Data extends _Event {
  _Data(this.value);
  final Object? value;
  @override
  String toString() => 'data($value)';
}

class _Error extends _Event {
  _Error(this.error);
  final Object error;
  @override
  String toString() => 'error($error)';
}

class _Done extends _Event {
  @override
  String toString() => 'done';
}

/// Records everything [stream] emits.
List<_Event> _record(Stream<Object?> stream) {
  final events = <_Event>[];
  stream.listen(
    (v) => events.add(_Data(v)),
    onError: (Object e) => events.add(_Error(e)),
    onDone: () => events.add(_Done()),
  );
  return events;
}

const _url = 'ws://realtime.test/';

RealtimeChannel<String> _channel(String name, {String token = 't'}) =>
    RealtimeChannel.fromJson({
      '__blocks': 'realtime/channel',
      'channel': name,
      'wsUrl': _url,
      'token': token,
    }, (json) => json['text'] as String);

Map<String, Object?> _message(String channel, String text) => {
  'type': 'message',
  'channel': channel,
  'data': {'text': text},
};

void main() {
  late List<FakeSocket> sockets;
  late WebSocketPool previous;
  // Whether the next sockets the pool opens finish their handshake.
  var handshakes = true;

  setUp(() {
    sockets = [];
    handshakes = true;
    previous = WebSocketPool.shared;
    WebSocketPool.shared = WebSocketPool(
      connect: (uri) {
        final socket = FakeSocket(uri, handshakeDone: handshakes);
        sockets.add(socket);
        return socket;
      },
    );
  });
  tearDown(() => WebSocketPool.shared = previous);

  group('subscribe', () {
    test('sends a subscribe frame with the channel token', () async {
      final channel = _channel('room', token: 'tok');
      addTearDown(channel.close);
      _record(channel.subscribe());
      expect(sockets.single.sent, [
        {'action': 'subscribe', 'channel': 'room', 'token': 'tok'},
      ]);
    });

    test('routes message frames by channel on a shared socket', () async {
      final a = _channel('a');
      final b = _channel('b');
      addTearDown(a.close);
      addTearDown(b.close);
      final aEvents = _record(a.subscribe());
      final bEvents = _record(b.subscribe());
      expect(sockets, hasLength(1));

      sockets.single
        ..send(_message('a', 'for a'))
        ..send(_message('b', 'for b'))
        ..send({'type': 'subscribe_success', 'channel': 'a'})
        ..sendRaw('not json');
      await pumpEventQueue();

      expect(aEvents.map((e) => '$e'), ['data(for a)']);
      expect(bEvents.map((e) => '$e'), ['data(for b)']);
    });

    test('two subscriptions to one channel both receive', () async {
      final channel = _channel('room');
      addTearDown(channel.close);
      final first = _record(channel.subscribe());
      final second = _record(channel.subscribe());

      sockets.single.send(_message('room', 'hi'));
      await pumpEventQueue();

      expect(first.map((e) => '$e'), ['data(hi)']);
      expect(second.map((e) => '$e'), ['data(hi)']);
    });

    test('reads the local dev server payload field', () async {
      final channel = _channel('room');
      addTearDown(channel.close);
      final events = _record(channel.subscribe());
      sockets.single.send({
        'type': 'message',
        'channel': 'room',
        'payload': {'text': 'mock'},
      });
      await pumpEventQueue();
      expect(events.map((e) => '$e'), ['data(mock)']);
    });
  });

  group('an error frame for a channel', () {
    for (final code in ['token_expired', 'access_revoked']) {
      test('$code ends only that channel with SubscriptionEnded', () async {
        final ended = _channel('ended');
        final other = _channel('other');
        addTearDown(ended.close);
        addTearDown(other.close);
        final endedEvents = _record(ended.subscribe());
        final otherEvents = _record(other.subscribe());

        sockets.single.send({
          'type': 'error',
          'channel': 'ended',
          'code': code,
          'message': 'Subscription ended',
        });
        sockets.single
          ..send(_message('ended', 'late'))
          ..send(_message('other', 'still here'));
        await pumpEventQueue();

        expect(endedEvents, hasLength(2));
        expect(
          (endedEvents[0] as _Error).error,
          isA<RealtimeSubscriptionEndedException>()
              .having((e) => e.channel, 'channel', 'ended')
              .having((e) => e.code, 'code', code)
              .having((e) => e.message, 'message', 'Subscription ended')
              .having((e) => e.cause, 'cause', isNull),
        );
        expect(endedEvents[1], isA<_Done>());
        expect(otherEvents.map((e) => '$e'), ['data(still here)']);
        expect(sockets.single.clientClosed, isFalse);
      });
    }

    test('a refused subscribe has a null code', () async {
      final channel = _channel('room');
      addTearDown(channel.close);
      final events = _record(channel.subscribe());

      sockets.single.send({
        'type': 'error',
        'channel': 'room',
        'message': 'Unauthorized: invalid or expired token',
      });
      await pumpEventQueue();

      expect(
        (events[0] as _Error).error,
        isA<RealtimeSubscriptionEndedException>()
            .having((e) => e.code, 'code', isNull)
            .having(
              (e) => e.message,
              'message',
              'Unauthorized: invalid or expired token',
            ),
      );
      expect(events[1], isA<_Done>());
      // The last subscription on the socket ended, so the socket closes.
      expect(sockets.single.clientClosed, isTrue);
    });

    test('a later subscribe on the same URL reuses a healthy socket', () async {
      final ended = _channel('ended');
      final other = _channel('other');
      addTearDown(ended.close);
      addTearDown(other.close);
      _record(ended.subscribe());
      _record(other.subscribe());
      sockets.single.send({
        'type': 'error',
        'channel': 'ended',
        'code': 'token_expired',
      });
      await pumpEventQueue();

      final renewed = _channel('ended', token: 'fresh');
      addTearDown(renewed.close);
      final events = _record(renewed.subscribe());
      sockets.single.send(_message('ended', 'again'));
      await pumpEventQueue();

      expect(sockets, hasLength(1));
      expect(sockets.single.sent.last, {
        'action': 'subscribe',
        'channel': 'ended',
        'token': 'fresh',
      });
      expect(events.map((e) => '$e'), ['data(again)']);
    });
  });

  group('connection ends', () {
    Future<void> expectConnectionEnd(
      void Function(FakeSocket socket) end,
      Matcher error,
    ) async {
      final a = _channel('a');
      final b = _channel('b');
      addTearDown(a.close);
      addTearDown(b.close);
      final aEvents = _record(a.subscribe());
      final bEvents = _record(b.subscribe());

      end(sockets.single);
      await pumpEventQueue();

      for (final events in [aEvents, bEvents]) {
        expect(events, hasLength(2));
        expect((events[0] as _Error).error, error);
        expect(events[1], isA<_Done>());
      }

      // The dead socket left the pool: the next subscribe opens a new one.
      _record(a.subscribe());
      expect(sockets, hasLength(2));
    }

    test('an error frame without a channel ends every subscription', () {
      return expectConnectionEnd(
        (s) => s.send({'type': 'error', 'message': 'Invalid channel'}),
        isA<RealtimeConnectionException>().having(
          (e) => e.message,
          'message',
          'Invalid channel',
        ),
      );
    });

    test('a server close ends every subscription', () {
      return expectConnectionEnd(
        (s) => s.close(1001, 'Going away'),
        isA<RealtimeConnectionException>()
            .having((e) => e.message, 'message', contains('1001'))
            .having((e) => e.cause, 'cause', isNull),
      );
    });

    test('a socket failure ends every subscription', () {
      final failure = Exception('connection reset');
      return expectConnectionEnd(
        (s) => s.fail(failure),
        isA<RealtimeConnectionException>().having(
          (e) => e.cause,
          'cause',
          same(failure),
        ),
      );
    });
  });

  group('a message that fails to decode', () {
    test('emits the decode error, then ends the stream', () async {
      final channel = _channel('room');
      final other = _channel('other');
      addTearDown(channel.close);
      addTearDown(other.close);
      final events = _record(channel.subscribe());
      _record(other.subscribe());

      sockets.single
        ..send({
          'type': 'message',
          'channel': 'room',
          'data': {'count': 1},
        })
        ..send(_message('room', 'after'));
      await pumpEventQueue();

      expect(events, hasLength(2));
      expect((events[0] as _Error).error, isA<TypeError>());
      expect(events[1], isA<_Done>());
      expect(sockets.single.clientClosed, isFalse);
    });
  });

  group('cancel and close', () {
    test('cancelling the last subscription closes the socket', () async {
      final channel = _channel('room');
      addTearDown(channel.close);
      final first = channel.subscribe().listen(null);
      final second = channel.subscribe().listen(null);

      await first.cancel();
      expect(sockets.single.clientClosed, isFalse);
      await second.cancel();
      expect(sockets.single.clientClosed, isTrue);
    });

    test('close() ends every active stream normally', () async {
      final channel = _channel('room');
      final first = _record(channel.subscribe());
      final second = _record(channel.subscribe());

      channel.close();
      await pumpEventQueue();

      expect(first, [isA<_Done>()]);
      expect(second, [isA<_Done>()]);
      expect(sockets.single.clientClosed, isTrue);
      expect(channel.subscribe, throwsA(isA<RealtimeChannelClosedException>()));
    });

    test('close() leaves other channels on the socket alone', () async {
      final closed = _channel('closed');
      final other = _channel('other');
      addTearDown(other.close);
      _record(closed.subscribe());
      final events = _record(other.subscribe());

      closed.close();
      sockets.single.send(_message('other', 'hi'));
      await pumpEventQueue();

      expect(events.map((e) => '$e'), ['data(hi)']);
      expect(sockets.single.clientClosed, isFalse);
    });
  });

  group('unsubscribe frame', () {
    test(
      'is sent when a channel\'s last subscriber leaves an open socket',
      () async {
        final room = _channel('room');
        final other = _channel('other');
        addTearDown(room.close);
        addTearDown(other.close);
        final first = room.subscribe().listen(null);
        final second = room.subscribe().listen(null);
        _record(other.subscribe());
        final socket = sockets.single;

        await first.cancel();
        expect(socket.unsubscribes, isEmpty, reason: 'room still has one');
        await second.cancel();
        expect(socket.unsubscribes, [
          {'action': 'unsubscribe', 'channel': 'room'},
        ]);
        expect(socket.clientClosed, isFalse);
      },
    );

    test('is sent by close() while other channels keep the socket', () async {
      final closed = _channel('closed');
      final other = _channel('other');
      addTearDown(other.close);
      _record(closed.subscribe());
      _record(other.subscribe());

      closed.close();
      expect(sockets.single.unsubscribes, [
        {'action': 'unsubscribe', 'channel': 'closed'},
      ]);
    });

    test('is sent when a decode failure ends the subscription', () async {
      final room = _channel('room');
      final other = _channel('other');
      addTearDown(room.close);
      addTearDown(other.close);
      _record(room.subscribe());
      _record(other.subscribe());

      sockets.single.send({
        'type': 'message',
        'channel': 'room',
        'data': {'count': 1},
      });
      await pumpEventQueue();

      expect(sockets.single.unsubscribes, [
        {'action': 'unsubscribe', 'channel': 'room'},
      ]);
    });

    test('is not sent when the last subscriber closes the socket', () async {
      final room = _channel('room');
      final sub = room.subscribe().listen(null);
      final socket = sockets.single;

      await sub.cancel();
      room.close();
      expect(socket.clientClosed, isTrue);
      expect(socket.unsubscribes, isEmpty);
    });

    test('is not sent for a subscription the server ended', () async {
      final ended = _channel('ended');
      final other = _channel('other');
      addTearDown(ended.close);
      addTearDown(other.close);
      _record(ended.subscribe());
      _record(other.subscribe());

      sockets.single.send({
        'type': 'error',
        'channel': 'ended',
        'code': 'token_expired',
      });
      await pumpEventQueue();
      ended.close();

      expect(sockets.single.unsubscribes, isEmpty);
    });

    test('is not sent after the socket closed', () async {
      final a = _channel('a');
      final b = _channel('b');
      addTearDown(a.close);
      addTearDown(b.close);
      _record(a.subscribe());
      _record(b.subscribe());
      final socket = sockets.single;

      socket.close(1001);
      await pumpEventQueue();
      a.close();
      b.close();

      expect(socket.unsubscribes, isEmpty);
    });
  });

  group('handshake timeout', () {
    test('ends the subscription when the upgrade never finishes', () {
      fakeAsync((async) {
        handshakes = false;
        final channel = _channel('room');
        final events = _record(channel.subscribe());
        final socket = sockets.single;

        async.elapse(
          realtimeHandshakeTimeout - const Duration(milliseconds: 1),
        );
        expect(events, isEmpty);
        async.elapse(const Duration(milliseconds: 1));

        expect(events, hasLength(2));
        expect(
          (events[0] as _Error).error,
          isA<RealtimeConnectionException>().having(
            (e) => e.message,
            'message',
            contains('30 s'),
          ),
        );
        expect(events[1], isA<_Done>());
        expect(socket.clientClosed, isTrue);

        // The socket left the pool: the next subscribe opens a new one.
        handshakes = true;
        channel.subscribe().listen(null);
        expect(sockets, hasLength(2));
        channel.close();
      });
    });

    test('does not fire once the handshake finished', () {
      fakeAsync((async) {
        final channel = _channel('room');
        final events = _record(channel.subscribe());

        async.elapse(realtimeHandshakeTimeout * 3);
        expect(events, isEmpty);
        expect(sockets.single.clientClosed, isFalse);
        channel.close();
      });
    });

    test('close() while connecting ends the stream and empties the pool', () {
      fakeAsync((async) {
        handshakes = false;
        final channel = _channel('room');
        final events = _record(channel.subscribe());
        final socket = sockets.single;
        async.elapse(const Duration(seconds: 5));

        channel.close();
        async.flushMicrotasks();
        expect(events, [isA<_Done>()]);
        expect(socket.clientClosed, isTrue);

        // Nothing left in the pool, and the timer no longer fires.
        async.elapse(realtimeHandshakeTimeout * 2);
        expect(events, [isA<_Done>()]);
        final other = _channel('room');
        other.subscribe().listen(null);
        expect(sockets, hasLength(2));
        other.close();
      });
    });
  });

  group('keep-alive ping', () {
    test('sends {"action":"ping"} every 9 minutes while subscribed', () {
      fakeAsync((async) {
        final channel = _channel('room');
        final sub = channel.subscribe().listen(null);
        final socket = sockets.single;

        async.elapse(const Duration(minutes: 8, seconds: 59));
        expect(socket.pings, isEmpty);
        async.elapse(const Duration(seconds: 1));
        expect(socket.pings, [
          {'action': 'ping'},
        ]);
        async.elapse(const Duration(minutes: 18));
        expect(socket.pings, hasLength(3));

        sub.cancel();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 30));
        expect(socket.pings, hasLength(3));
        channel.close();
      });
    });

    test('one socket pings once per interval for all its channels', () {
      fakeAsync((async) {
        final a = _channel('a');
        final b = _channel('b');
        a.subscribe().listen(null);
        b.subscribe().listen(null);

        async.elapse(realtimeKeepAliveInterval);
        expect(sockets.single.pings, hasLength(1));
        a.close();
        b.close();
      });
    });

    test('stops when the socket closes', () {
      fakeAsync((async) {
        final channel = _channel('room');
        channel.subscribe().listen(null, onError: (_) {});
        final socket = sockets.single;
        socket.close(1006);
        async.flushMicrotasks();

        async.elapse(const Duration(minutes: 30));
        expect(socket.pings, isEmpty);
        channel.close();
      });
    });
  });
}
