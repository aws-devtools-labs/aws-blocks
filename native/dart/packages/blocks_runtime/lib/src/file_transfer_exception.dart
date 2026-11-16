/// @docImport 'file_download_handle.dart';
/// @docImport 'file_upload_handle.dart';
library;

import 'blocks_exception.dart';

/// Thrown by a [FileUploadHandle] or [FileDownloadHandle] transfer that the
/// runtime itself rejects: the presigned URL answered with an HTTP error
/// status, or an upload's source yielded a different number of bytes than its
/// `contentLength`.
///
/// A network failure, a timeout, or an error from the caller's own source or
/// sink is rethrown as it is, not wrapped in this type.
class FileTransferException implements BlocksException {
  const FileTransferException(this.message, {this.statusCode, this.cause});

  @override
  final String message;

  /// The HTTP status of the response, or null when the transfer failed
  /// before a response arrived (a byte-count mismatch).
  final int? statusCode;

  /// The error that caused this one, when there is one.
  final Object? cause;

  @override
  String toString() => cause == null
      ? 'FileTransferException: $message'
      : 'FileTransferException: $message (cause: $cause)';
}
