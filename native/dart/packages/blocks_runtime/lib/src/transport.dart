// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';

import 'package:http/http.dart' as http;

import 'blocks_exception.dart';

/// Runs [send] and reports an [Exception] it throws, which means the request
/// got no usable response, as the exception [wrap] makes of it, so no type of
/// the HTTP client's crosses the public surface.
///
/// Three things pass through as they are: a [BlocksException], which is
/// already the runtime's own report, such as an `OidcCancelledException`; an
/// [http.RequestAbortedException], which is the caller cancelling its own
/// request; and an [Error], which is a bug rather than a failed request. The
/// stack trace is kept.
///
/// Not exported.
Future<T> guardTransport<T>(
  Future<T> Function() send,
  BlocksException Function(Exception error) wrap,
) async {
  try {
    return await send();
  } on BlocksException {
    rethrow;
  } on http.RequestAbortedException {
    rethrow;
  } on Exception catch (e, st) {
    Error.throwWithStackTrace(wrap(e), st);
  }
}

/// [guardTransport] for a request whose failure is a [TransportException]
/// with no status.
Future<T> guardRequest<T>(Future<T> Function() send) => guardTransport(
  send,
  (e) => TransportException(transportFailureMessage(e), cause: e),
);

/// The message of the HTTP client's [error], without its type name where the
/// type is known.
String transportFailureMessage(Exception error) => switch (error) {
  http.ClientException(:final message) when message.isNotEmpty => message,
  TimeoutException(:final message?) when message.isNotEmpty => message,
  TimeoutException() => 'The request timed out',
  _ => error.toString(),
};

/// The HTTP status a JSON-RPC `error.code` reports. A server's `ApiError`
/// sends its HTTP status as the code, and a positive code never collides with
/// JSON-RPC's reserved `-32xxx` range. Any other code, including a missing
/// one, has no HTTP meaning and is reported as 500.
int rpcStatus(Object? code) => code is int && code > 0 ? code : 500;

/// The error name for a reserved JSON-RPC [code], or null for any other code.
///
/// The server names some protocol-level failures and not others: it sends no
/// `data` at all for a method that doesn't exist or a body it can't parse.
/// Reported as a 500, those would look like a crashed handler. These names are
/// the server's own (`RpcErrorCode`) for the same codes, so a name it does
/// send is the same as the one here. A name the server sent always wins; this
/// only fills a gap.
String? reservedRpcErrorName(Object? code) => switch (code) {
  -32700 => 'ParseError',
  -32600 => 'InvalidRequest',
  -32601 => 'MethodNotFound',
  -32602 => 'InvalidParams',
  -32603 => 'InternalError',
  _ => null,
};
