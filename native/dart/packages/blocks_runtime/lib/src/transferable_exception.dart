// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'blocks_exception.dart';

/// Thrown when a `{"__blocks": …}` descriptor the server sent cannot be
/// hydrated into a client-side handle, such as a `RealtimeChannel` or a
/// `FileDownloadHandle`: it is not an object, or its `__blocks` tag is
/// missing or not the expected one.
///
/// A handle that hydrated and then failed at work throws its own feature's
/// error instead, such as a `FileTransferException`.
class TransferableException extends BlocksException {
  const TransferableException(super.message);
}

/// Thrown when a descriptor lacks a field the client needs to build its
/// handle, or the field has the wrong type, such as a channel descriptor
/// without a `wsUrl`.
final class InvalidDescriptorException extends TransferableException {
  /// The descriptor's `__blocks` tag, such as `realtime/channel`.
  final String blocksType;

  /// The field that is missing or unusable.
  final String missingField;

  const InvalidDescriptorException(
    super.message, {
    required this.blocksType,
    required this.missingField,
  });
}
