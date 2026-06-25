import 'dart:async';
import 'dart:convert';

import 'web_socket_pool.dart';

/// A live WebSocket subscription that produces a typed [Stream] of messages.
class RealtimeChannel<T> {
  /// Shared pool across all channel instances for connection reuse.
  static final WebSocketPool _pool = WebSocketPool();

  final String channel;
  final String wsUrl;
  final String? connectToken;
  final String token;
  final T Function(Map<String, dynamic>) _deserializer;
  bool _closed = false;
  bool _subscribed = false;
  StreamController<T>? _controller;

  RealtimeChannel._({
    required this.channel,
    required this.wsUrl,
    this.connectToken,
    required this.token,
    required T Function(Map<String, dynamic>) deserializer,
  }) : _deserializer = deserializer;

  /// Hydrates a RealtimeChannel from a JSON descriptor.
  static RealtimeChannel<T> fromJson<T>(
    Map<String, dynamic> descriptor,
    T Function(Map<String, dynamic>) deserializer,
  ) {
    return RealtimeChannel._(
      channel: descriptor['channel'] as String,
      wsUrl: descriptor['wsUrl'] as String,
      connectToken: descriptor['connectToken'] as String?,
      token: descriptor['token'] as String,
      deserializer: deserializer,
    );
  }

  /// Builds the WebSocket URL, appending connectToken as query param for AWS.
  String get _connectionUrl {
    if (connectToken == null) return wsUrl;
    final uri = Uri.parse(wsUrl);
    final params = Map<String, String>.from(uri.queryParameters);
    params['token'] = connectToken!;
    return uri.replace(queryParameters: params).toString();
  }

  /// Opens the WebSocket, subscribes, and returns a typed Stream.
  Stream<T> subscribe() {
    if (_closed) throw StateError('Channel is closed');

    final url = _connectionUrl;
    final ws = _pool.acquire(url);
    _subscribed = true;
    final controller = StreamController<T>();
    _controller = controller;

    // Send subscribe message
    ws.sink.add(jsonEncode({
      'action': 'subscribe',
      'channel': channel,
      'token': token,
    }));

    final subscription = ws.stream.listen(
      (data) {
        final json = jsonDecode(data as String) as Map<String, dynamic>;
        if (json['type'] != 'message') return;
        // AWS uses 'data', mock uses 'payload'
        final payload =
            (json['data'] ?? json['payload']) as Map<String, dynamic>;
        controller.add(_deserializer(payload));
      },
      onError: controller.addError,
      onDone: () => controller.close(),
    );

    controller.onCancel = () {
      subscription.cancel();
      _pool.release(url);
    };

    return controller.stream;
  }

  /// Closes the channel and releases the pooled connection.
  void close() {
    if (_closed) return;
    _closed = true;
    if (_subscribed) {
      _pool.release(_connectionUrl);
    }
    _controller?.close();
  }
}
