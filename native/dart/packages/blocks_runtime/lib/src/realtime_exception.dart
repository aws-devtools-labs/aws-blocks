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

/// The channel's WebSocket connection failed. [cause] is the WebSocket
/// client's own error.
///
/// A subscription's stream emits it, then closes.
final class RealtimeConnectionException extends RealtimeException {
  const RealtimeConnectionException(super.message, [super.cause]);
}
