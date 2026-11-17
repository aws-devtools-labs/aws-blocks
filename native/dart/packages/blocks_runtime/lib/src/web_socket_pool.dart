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
  }

  final WebSocketPool _pool;
  final String url;
  final WebSocketChannel socket;
  final List<RealtimeSubscriber> _subscribers = [];
  late final StreamSubscription<dynamic> _frames;
  late final Timer _keepAlive;
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
  void remove(RealtimeSubscriber subscriber) {
    _subscribers.remove(subscriber);
    if (_subscribers.isEmpty) _shutDown();
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
            remove(s);
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
  }) : _connect = connect ?? _defaultConnect;

  /// The pool every `RealtimeChannel` shares.
  static WebSocketPool shared = WebSocketPool();

  final WebSocketConnector _connect;

  /// How often each socket sends `{"action":"ping"}`.
  final Duration keepAliveInterval;

  final Map<String, PooledConnection> _pool = {};

  static WebSocketChannel _defaultConnect(Uri uri) =>
      // WebSocket upgrades bypass http.Client; connectWebSocket attaches this
      // header where the platform permits custom upgrade headers.
      connectWebSocket(uri, {'User-Agent': blocksUserAgentToken});

  /// Returns the live connection for [url], opening one when there is none.
  PooledConnection acquire(String url) =>
      _pool[url] ??= PooledConnection._(this, url, _connect(Uri.parse(url)));

  void _forget(PooledConnection connection) {
    if (identical(_pool[connection.url], connection)) {
      _pool.remove(connection.url);
    }
  }
}
