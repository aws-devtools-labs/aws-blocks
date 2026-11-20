// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'realtime_exception.dart';
import 'user_agent.dart';
import 'web_socket_connect.dart';

/// Opens a WebSocket to a URL. The pool's default opens a real socket; tests
/// pass a fake.
typedef WebSocketConnector = WebSocketChannel Function(Uri uri);

/// How often a socket with a subscription sends `{"action":"ping"}`.
///
/// The server re-checks a connection's subscriptions only when it receives
/// this JSON message, and API Gateway closes a socket after 10 minutes with
/// no traffic. Nine minutes matches the web client.
const realtimeKeepAliveInterval = Duration(minutes: 9);

/// How long a new socket may take to finish the WebSocket handshake.
///
/// A server that accepts the TCP connection and never answers the upgrade
/// would otherwise leave a subscription waiting forever. Thirty seconds
/// matches the Kotlin and Swift clients. It bounds only the handshake: an
/// open socket has no idle timeout.
const realtimeHandshakeTimeout = Duration(seconds: 30);

/// Receives the frames of one channel on a pooled socket, and learns when the
/// subscription ends.
///
/// [onMessage] gets the payload of each `message` frame for [channel].
/// [onEnd] is called at most once, with the error that ended the
/// subscription, after which the subscriber is no longer on the socket.
class RealtimeSubscriber {
  RealtimeSubscriber({
    required this.channel,
    required this.onMessage,
    required this.onEnd,
  });

  final String channel;
  final void Function(Object? payload) onMessage;
  final void Function(RealtimeException error) onEnd;
}

/// One pooled socket and the subscribers that share it.
class PooledConnection {
  PooledConnection._(this._pool, this.url, this.socket) {
    _frames = socket.stream.listen(
      _onFrame,
      onError: (Object error) => _fail(
        error is RealtimeException
            ? error
            : RealtimeConnectionException('Realtime connection failed', error),
      ),
      onDone: () => _fail(
        RealtimeConnectionException(
          socket.closeCode == null
              ? 'Realtime connection closed'
              : 'Realtime connection closed (code ${socket.closeCode}'
                    '${socket.closeReason == null || socket.closeReason!.isEmpty ? '' : ': ${socket.closeReason}'})',
        ),
      ),
    );
    _keepAlive = Timer.periodic(
      _pool.keepAliveInterval,
      (_) => socket.sink.add(jsonEncode({'action': 'ping'})),
    );
    final timeout = _pool.handshakeTimeout;
    _handshake = Timer(
      timeout,
      () => _fail(
        RealtimeConnectionException(
          'Realtime connection timed out: no WebSocket handshake after '
          '${timeout.inSeconds} s',
        ),
      ),
    );
    // A failed handshake also errors the stream, which ends the
    // subscriptions; here it only needs to stop the timer.
    socket.ready.then((_) => _handshake.cancel(), onError: (_) {}).ignore();
  }

  final WebSocketPool _pool;
  final String url;
  final WebSocketChannel socket;
  final List<RealtimeSubscriber> _subscribers = [];
  late final StreamSubscription<dynamic> _frames;
  late final Timer _keepAlive;
  late final Timer _handshake;
  bool _dead = false;

  /// Adds [subscriber] and sends its `subscribe` frame with [token].
  void subscribe(RealtimeSubscriber subscriber, String token) {
    _subscribers.add(subscriber);
    socket.sink.add(
      jsonEncode({
        'action': 'subscribe',
        'channel': subscriber.channel,
        'token': token,
      }),
    );
  }

  /// Removes [subscriber] without calling its `onEnd`. Closes the socket when
  /// no subscriber is left.
  ///
  /// When [subscriber] was its channel's last subscriber and the socket stays
  /// open for other channels, sends `{"action":"unsubscribe"}` for the
  /// channel, so the server stops delivering it. Closing the socket ends
  /// every subscription on the server, so no frame is needed then.
  void remove(RealtimeSubscriber subscriber) {
    _detach(subscriber, serverEnded: false);
  }

  /// Removes [subscriber]. [serverEnded] is true when the server already
  /// ended the channel's subscription, which needs no unsubscribe.
  void _detach(RealtimeSubscriber subscriber, {required bool serverEnded}) {
    if (_dead || !_subscribers.remove(subscriber)) return;
    if (_subscribers.isEmpty) {
      _shutDown();
      return;
    }
    if (serverEnded) return;
    final channel = subscriber.channel;
    if (_subscribers.any((s) => s.channel == channel)) return;
    socket.sink.add(jsonEncode({'action': 'unsubscribe', 'channel': channel}));
  }

  void _onFrame(dynamic data) {
    final Object? decoded;
    try {
      decoded = jsonDecode(data as String);
    } on Object {
      // The server only sends JSON objects; skip anything else, as the web
      // client does.
      return;
    }
    if (decoded is! Map<String, dynamic>) return;
    final channel = decoded['channel'];
    switch (decoded['type']) {
      case 'message':
        if (channel is! String) return;
        // AWS sends 'data', the local dev server 'payload'.
        final Object? payload = decoded['data'] ?? decoded['payload'];
        for (final s in [..._subscribers]) {
          if (s.channel == channel && _subscribers.contains(s)) {
            s.onMessage(payload);
          }
        }
      case 'error':
        final code = decoded['code'];
        final message = decoded['message'];
        if (channel is String) {
          // The server already ended this channel's subscription; end ours.
          final ended = _subscribers
              .where((s) => s.channel == channel)
              .toList();
          for (final s in ended) {
            _detach(s, serverEnded: true);
            s.onEnd(
              RealtimeSubscriptionEndedException(
                channel,
                code is String ? code : null,
                message is String && message.isNotEmpty
                    ? message
                    : 'The server ended the subscription to "$channel"',
              ),
            );
          }
        } else {
          _fail(
            RealtimeConnectionException(
              message is String && message.isNotEmpty
                  ? message
                  : 'The server reported a connection error',
            ),
          );
        }
    }
  }

  /// Ends every subscriber with [error] and drops the socket.
  void _fail(RealtimeException error) {
    if (_dead) return;
    final ended = [..._subscribers];
    _subscribers.clear();
    _shutDown();
    for (final s in ended) {
      s.onEnd(error);
    }
  }

  void _shutDown() {
    if (_dead) return;
    _dead = true;
    _keepAlive.cancel();
    _handshake.cancel();
    _frames.cancel().ignore();
    socket.sink.close().ignore();
    _pool._forget(this);
  }
}

/// Manages pooled WebSocket connections keyed by URL.
///
/// Each socket is read once and its frames are routed to subscribers by
/// channel, so any number of subscriptions can share it. A socket that fails
/// or closes leaves the pool, so the next subscribe opens a new one.
class WebSocketPool {
  WebSocketPool({
    WebSocketConnector? connect,
    this.keepAliveInterval = realtimeKeepAliveInterval,
    this.handshakeTimeout = realtimeHandshakeTimeout,
  }) : _connect = connect ?? ((uri) => _defaultConnect(uri, handshakeTimeout));

  /// The pool every `RealtimeChannel` shares.
  static WebSocketPool shared = WebSocketPool();

  final WebSocketConnector _connect;

  /// How often each socket sends `{"action":"ping"}`.
  final Duration keepAliveInterval;

  /// How long a new socket may take to finish the WebSocket handshake before
  /// its subscriptions end with a `RealtimeConnectionException`.
  final Duration handshakeTimeout;

  final Map<String, PooledConnection> _pool = {};

  static WebSocketChannel _defaultConnect(Uri uri, Duration handshake) =>
      // WebSocket upgrades bypass http.Client; connectWebSocket attaches this
      // header where the platform permits custom upgrade headers.
      connectWebSocket(uri, {
        'User-Agent': blocksUserAgentToken,
      }, handshakeTimeout: handshake);

  /// Returns the live connection for [url], opening one when there is none.
  PooledConnection acquire(String url) =>
      _pool[url] ??= PooledConnection._(this, url, _connect(Uri.parse(url)));

  void _forget(PooledConnection connection) {
    if (identical(_pool[connection.url], connection)) {
      _pool.remove(connection.url);
    }
  }
}
