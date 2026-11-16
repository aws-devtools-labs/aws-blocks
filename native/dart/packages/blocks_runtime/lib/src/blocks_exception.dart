/// @docImport 'blocks_rpc_exception.dart';
/// @docImport 'file_transfer_exception.dart';
library;

/// Implemented by [BlocksRpcException] and [FileTransferException], so
/// `on BlocksException` catches either.
///
/// Failures that come from Dart or `package:http` are rethrown as they are
/// rather than wrapped: a timeout is a dart:async `TimeoutException`, and a
/// network failure (including a call on a closed `BlocksClient`) is an
/// `http.ClientException`.
abstract interface class BlocksException implements Exception {
  /// What went wrong, for a person to read. Match on a type, or on a server
  /// error's `name`, rather than on this text.
  String get message;

  /// The error that caused this one, or null when there is none.
  Object? get cause;
}
