// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'blocks_exception.dart';

/// Base of the failures on a realtime channel.
///
/// Sealed, so a `switch` over it is exhaustive: one case per kind of failure.
/// The set of kinds is fixed when the runtime reaches 1.0.0, because a new
/// kind after that would break every exhaustive `switch` in an app.
sealed class RealtimeException extends BlocksException {
  const RealtimeException(super.message, [super.cause]);
}

/// Thrown by `RealtimeChannel.subscribe` on a channel that is closed.
///
/// A channel can close on its own when the server goes away or the
/// connection drops, so a subscribe after close is not necessarily the
/// caller's mistake. It is a catchable error rather than a [StateError].
final class RealtimeChannelClosedException extends RealtimeException {
  const RealtimeChannelClosedException() : super('Channel is closed');
}

/// The channel's WebSocket connection failed or closed.
///
/// Emitted when the socket couldn't open (including a refused connect
/// token), failed, or was closed by the server or the gateway (API Gateway
/// closes a socket after 10 minutes with no traffic, and after 2 hours in any
/// case). Also emitted for an error frame from the server that names no
/// channel. [cause] is the WebSocket client's own error, or null when the
/// socket closed without one.
///
/// Every subscription on the socket emits it, then its stream closes. The
/// SDK doesn't reconnect: get the channel again from the API method that
/// returned it and subscribe to the new handle.
final class RealtimeConnectionException extends RealtimeException {
  const RealtimeConnectionException(super.message, [super.cause]);
}

/// The server ended one channel's subscription, or refused it.
///
/// The socket may still be healthy for other channels; only the
/// subscriptions to [channel] end. The stream emits this error, then closes.
///
/// [code] is the server's reason, as sent, or null when it sent none. It is a
/// string rather than an enum because the server can add codes. The known
/// values:
///
/// - `token_expired`: the channel token expired (it lasts about an hour). Get
///   the channel again from the API method that returned it, and subscribe to
///   the new handle.
/// - `access_revoked`: the backend called `revokeAccess()` for the user the
///   channel was issued to. Don't retry as the same user.
/// - `principal_mismatch`: the channel was issued to a different user than
///   the connection's. Don't retry as the same user.
/// - null: the server refused the subscribe, for example because the token
///   is invalid or expired.
///
/// [message] is the server's own message.
final class RealtimeSubscriptionEndedException extends RealtimeException {
  /// The channel whose subscription ended.
  final String channel;

  /// The server's reason, such as `token_expired`, or null when it sent none.
  final String? code;

  const RealtimeSubscriptionEndedException(
    this.channel,
    this.code,
    super.message, [
    super.cause,
  ]);

  @override
  String toString() =>
      'RealtimeSubscriptionEndedException($channel${code == null ? '' : ', $code'}): $message'
      '${cause == null ? '' : ' (cause: $cause)'}';
}
