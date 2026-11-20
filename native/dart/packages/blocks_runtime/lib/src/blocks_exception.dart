// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// Base class of every error the CDK Blocks runtime throws.
///
/// Catch this to handle any CDK Blocks failure generically. For finer-grained
/// handling, catch a subtype:
///
/// - [ApiException]: the server considered the request and said no.
/// - [TransportException]: no usable JSON-RPC result came back.
/// - [ClientClosedException]: a call through a closed `BlocksClient`.
/// - `TransferableException`: a `__blocks` descriptor could not be hydrated.
/// - `FileTransferException`: a file upload or download failed.
/// - `RealtimeException`: a realtime channel failed.
/// - `OidcException`: an OIDC sign-in flow failed.
///
/// Arguments the caller controls are still checked with the language's own
/// [ArgumentError] before any request is sent.
abstract class BlocksException implements Exception {
  /// What went wrong.
  final String message;

  /// The underlying failure, when there is one, such as the HTTP client's own
  /// error for a request that got no response.
  final Object? cause;

  const BlocksException(this.message, [this.cause]);

  @override
  String toString() => cause == null
      ? '$runtimeType: $message'
      : '$runtimeType: $message (cause: $cause)';
}

/// Thrown when the server answers with an error: the request reached the
/// server and was rejected (authentication required, validation failed, a
/// conflict).
///
/// A JSON-RPC error envelope is an [ApiException] at any HTTP status, so a
/// backend namespace created with `httpErrorStatus: true` (which answers with
/// the error's own status) decodes the same as one that answers 200. So is an
/// auth route that refuses a request, such as a sign-out the server could
/// not finish.
///
/// Match on [name], with [isBlocksError], rather than on [status] or
/// [message]: a named error the backend threw without a status arrives as a
/// 500 with its name intact, so `status == 500` does not mean an unknown
/// server fault. Use [status] for generic handling, such as retrying a 5xx or
/// signing in again on a 401.
final class ApiException extends BlocksException {
  /// The HTTP status the server rejected the request with. JSON-RPC's
  /// reserved codes (`-32700` to `-32603`) have no HTTP meaning and are
  /// reported as 500, as the TypeScript client reports them.
  final int status;

  /// The server's error name, such as `ConditionalCheckFailedException`, or
  /// null when it sent none. For a reserved JSON-RPC code the server sent
  /// without a name, this is the code's name (`ParseError`, `InvalidRequest`,
  /// `MethodNotFound`, `InvalidParams` or `InternalError`); a name the server
  /// did send always wins.
  final String? name;

  /// Whether the same action can be retried without restarting the wider
  /// flow. Meaningful for multi-step flows such as an auth challenge, where a
  /// wrong code can be entered again against the same session but an expired
  /// session cannot. False when the server didn't say.
  final bool retriable;

  /// [message] is the server's own message, passed through unchanged.
  const ApiException(
    super.message, {
    required this.status,
    this.name,
    this.retriable = false,
  });

  @override
  String toString() => name == null
      ? 'ApiException($status): $message'
      : 'ApiException($status $name): $message';
}

/// Thrown when a request produced no usable JSON-RPC result: no response
/// arrived at all (a refused connection, a DNS or TLS failure, a timeout), or
/// what came back was not a JSON-RPC result (a gateway's own error page, a
/// body that is not JSON, or JSON that is not a JSON-RPC envelope).
///
/// A request the server considered and rejected is an [ApiException] instead.
///
/// The HTTP client's own error is the [cause], so a caller that needs it can
/// still reach it; a timeout, for example, has a `TimeoutException` cause.
final class TransportException extends BlocksException {
  /// The HTTP status of the response, or null when no response arrived.
  final int? statusCode;

  const TransportException(String message, {this.statusCode, Object? cause})
    : super(message, cause);

  @override
  String toString() {
    final head = statusCode == null
        ? 'TransportException: $message'
        : 'TransportException($statusCode): $message';
    return cause == null ? head : '$head (cause: $cause)';
  }
}

/// Thrown by a call through a `BlocksClient` that has been closed.
///
/// A closed client owns no HTTP connection, so the call fails here, before
/// anything is sent, instead of with the HTTP client's own error.
final class ClientClosedException extends BlocksException {
  const ClientClosedException([super.message = 'BlocksClient is closed']);
}

/// True when [error] is an [ApiException] whose [ApiException.name] is
/// [name].
///
/// Errors cross the wire by name, so match with this rather than on a
/// message or a status. It works the same as the TypeScript client's
/// `isBlocksError`:
///
/// ```dart
/// try {
///   await blocks.api.reserve(username);
/// } on Exception catch (e) {
///   if (isBlocksError(e, 'ConditionalCheckFailedException')) {
///     showTaken();
///   } else {
///     rethrow;
///   }
/// }
/// ```
bool isBlocksError(Object? error, String name) =>
    error is ApiException && error.name == name;
