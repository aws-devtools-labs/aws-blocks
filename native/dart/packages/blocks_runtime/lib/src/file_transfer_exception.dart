// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'blocks_exception.dart';

/// Thrown when an upload or download through a file-bucket handle fails: the
/// presigned URL rejected the transfer, or the connection failed.
///
/// Hydrating the handle itself is a different failure: an unusable
/// descriptor is a `TransferableException`.
final class FileTransferException extends BlocksException {
  /// The HTTP status the transfer was rejected with, or null when the request
  /// got no response. Then [cause] is the HTTP client's own error.
  final int? statusCode;

  const FileTransferException(String message, {this.statusCode, Object? cause})
    : super(message, cause);
}
