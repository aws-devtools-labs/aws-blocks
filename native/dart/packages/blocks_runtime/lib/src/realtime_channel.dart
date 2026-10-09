import 'dart:async';
import 'dart:convert';

import 'transferable_descriptor.dart';
import 'web_socket_pool.dart';

/// A live WebSocket subscription that produces a typed [Stream] of messages.
class RealtimeChannel<T> {
  /// Shared pool across all channel instances for connection reuse.
  static final WebSocketPool _pool = WebSocketPool();

  final String channel;
  final String wsUrl;
  final String? connectToken;
  final String token;
  final T Function(Object? payload) _decode;

  /// The descriptor this channel was hydrated from, as [toJson] returns it.
  final Map<String, dynamic> _descriptor;
  bool _closed = false;
  bool _subscribed = false;
  StreamController<T>? _controller;

  RealtimeChannel._({
    required this.channel,
    required this.wsUrl,
    this.connectToken,
    required this.token,
    required T Function(Object? payload) decode,
    required Map<String, dynamic> descriptor,
  }) : _decode = decode,
       _descriptor = descriptor;

  /// Hydrates a RealtimeChannel from a JSON descriptor.
  ///
  /// [deserializer] receives each message's payload, which must be a JSON
  /// object. For a channel whose messages are any other JSON value (an array,
  /// string, number, boolean, or null), use [fromJsonValue].
  static RealtimeChannel<T> fromJson<T>(
    Map<String, dynamic> descriptor,
    T Function(Map<String, dynamic>) deserializer,
  ) {
    return fromJsonValue(
      descriptor,
      (payload) => deserializer(payload as Map<String, dynamic>),
    );
  }

  /// Hydrates a RealtimeChannel from a JSON descriptor, decoding each
  /// message's payload — any JSON value, as returned by `jsonDecode` — with
  /// [decode].
  ///
  /// ```dart
  /// final RealtimeChannel<List<String>> tags = RealtimeChannel.fromJsonValue(
  ///   descriptor,
  ///   (payload) => (payload as List<dynamic>).cast<String>(),
  /// );
  /// ```
  static RealtimeChannel<T> fromJsonValue<T>(
    Map<String, dynamic> descriptor,
    T Function(Object? payload) decode,
  ) {
    return RealtimeChannel._(
      channel: descriptor['channel'] as String,
      wsUrl: descriptor['wsUrl'] as String,
      connectToken: descriptor['connectToken'] as String?,
      token: descriptor['token'] as String,
      decode: decode,
      descriptor: descriptor,
    );
  }

  /// This channel's descriptor, as the server's `toJSON()` sent it and
  /// [fromJson] read it: `{"__blocks": "realtime/channel", "channel",
  /// "wsUrl", "connectToken"?, "token"}`, with any other key it held. A
  /// generated client sends a channel parameter, or a channel inside a model
  /// it sends, this way; `jsonEncode` calls it too.
  ///
  /// ```dart
  /// final body = jsonEncode({'feed': channel.toJson()});
  /// ```
  ///
  /// Returns a copy, so changing it doesn't change this channel.
  Map<String, dynamic> toJson() =>
      transferableDescriptor('realtime/channel', _descriptor);

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
    ws.sink.add(
      jsonEncode({'action': 'subscribe', 'channel': channel, 'token': token}),
    );

    final subscription = ws.stream.listen(
      (data) {
        final json = jsonDecode(data as String) as Map<String, dynamic>;
        if (json['type'] != 'message') return;
        // AWS uses 'data', mock uses 'payload'
        final Object? payload = json['data'] ?? json['payload'];
        controller.add(_decode(payload));
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
