// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';

import 'realtime_exception.dart';
import 'transferable_descriptor.dart';
import 'web_socket_pool.dart';

/// A live WebSocket subscription that produces a typed [Stream] of messages.
///
/// A subscription's stream closes normally only when the app ends it, by
/// cancelling the stream subscription or calling [close]. Every other end
/// emits one [RealtimeException], then closes the stream:
///
/// - [RealtimeSubscriptionEndedException] when the server ends or refuses this
///   channel's subscription, for example when the channel token expires
///   (`code` `token_expired`, about an hour after the channel was issued).
/// - [RealtimeConnectionException] when the WebSocket fails or closes.
///
/// The SDK doesn't renew or reconnect by itself. To keep listening, call the
/// API method that returned the channel again and subscribe to the new
/// handle:
///
/// ```dart
/// Future<void> follow(String room) async {
///   final channel = await blocks.api.realtimeGetChannel(channel: room);
///   try {
///     await for (final cursor in channel.subscribe()) {
///       draw(cursor);
///     }
///   } on RealtimeSubscriptionEndedException catch (e) {
///     if (e.code == 'token_expired') return follow(room);
///     rethrow;
///   }
/// }
/// ```
final class RealtimeChannel<T> {
  final String channel;
  final String wsUrl;
  final String? connectToken;
  final String token;
  final T Function(Object? payload) _decode;
  bool _closed = false;
  final Set<_Subscription<T>> _subscriptions = {};

  RealtimeChannel._({
    required this.channel,
    required this.wsUrl,
    this.connectToken,
    required this.token,
    required T Function(Object? payload) decode,
  }) : _decode = decode;

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
  ///
  /// Throws an `InvalidDescriptorException` when [descriptor] has no string
  /// `channel`, `wsUrl` or `token`.
  static RealtimeChannel<T> fromJsonValue<T>(
    Map<String, dynamic> descriptor,
    T Function(Object? payload) decode,
  ) {
    String field(String name) => requireDescriptorField<String>(
      descriptor,
      name,
      tag: 'realtime/channel',
      subject: 'RealtimeChannel',
    );
    return RealtimeChannel._(
      channel: field('channel'),
      wsUrl: field('wsUrl'),
      connectToken: descriptor['connectToken'] as String?,
      token: field('token'),
      decode: decode,
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
  ///
  /// Returns at once, without waiting for the server to confirm the
  /// subscription, so a message published before the server confirms can be
  /// missed. A refused subscribe ends the stream with a
  /// [RealtimeSubscriptionEndedException].
  ///
  /// Subscriptions to channels on the same WebSocket URL share one socket,
  /// which sends `{"action":"ping"}` every 9 minutes while it has a
  /// subscription. The ping keeps the socket open and is when the server
  /// re-checks each subscription's token.
  ///
  /// Throws a [RealtimeChannelClosedException] when the channel is closed.
  /// When the WebSocket connection fails, the stream emits a
  /// [RealtimeConnectionException] whose `cause` is the WebSocket client's
  /// error. A message whose payload fails to decode emits the decoder's error
  /// (such as a `TypeError`), then the stream closes.
  Stream<T> subscribe() {
    if (_closed) throw const RealtimeChannelClosedException();

    final controller = StreamController<T>();
    final connection = WebSocketPool.shared.acquire(_connectionUrl);
    late final _Subscription<T> subscription;
    final subscriber = RealtimeSubscriber(
      channel: channel,
      onMessage: (payload) {
        final T value;
        try {
          value = _decode(payload);
        } on Object catch (e, st) {
          subscription.end(e, st);
          return;
        }
        controller.add(value);
      },
      onEnd: (error) => subscription.end(error, StackTrace.current),
    );
    subscription = _Subscription(this, connection, subscriber, controller);
    _subscriptions.add(subscription);
    controller.onCancel = subscription.cancel;
    connection.subscribe(subscriber, token);
    return controller.stream;
  }

  /// Closes the channel and releases the pooled connection.
  ///
  /// Every active subscription's stream closes normally, and a later
  /// [subscribe] throws a [RealtimeChannelClosedException].
  void close() {
    if (_closed) return;
    _closed = true;
    for (final s in [..._subscriptions]) {
      s.cancel();
      s.controller.close().ignore();
    }
  }
}

/// One `subscribe()` call's stream and its place on a pooled socket.
class _Subscription<T> {
  _Subscription(this.owner, this.connection, this.subscriber, this.controller);

  final RealtimeChannel<T> owner;
  final PooledConnection connection;
  final RealtimeSubscriber subscriber;
  final StreamController<T> controller;

  /// Leaves the socket. Safe to call more than once.
  void cancel() {
    if (!owner._subscriptions.remove(this)) return;
    connection.remove(subscriber);
  }

  /// Emits [error] and closes the stream.
  void end(Object error, StackTrace stackTrace) {
    cancel();
    if (controller.isClosed) return;
    controller.addError(error, stackTrace);
    controller.close().ignore();
  }
}
