// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'transferable_exception.dart';

/// Throws a [TransferableException] unless [json] is an object whose `__blocks` is a
/// non-empty string equal to [expectedTag]; returns that same instance, not a
/// copy, so the caller owns any copying it needs.
Map<String, dynamic> validateTransferableDescriptor(
  Object? json, {
  required String expectedTag,
  String subject = 'Transferable',
}) {
  if (json is! Map<String, dynamic>) {
    throw TransferableException(
      "$subject for '$expectedTag' expected a JSON object descriptor",
    );
  }
  final tag = json['__blocks'];
  if (tag is! String) {
    throw TransferableException(
      "$subject for '$expectedTag' expected a string '__blocks' tag",
    );
  }
  if (tag.isEmpty) {
    throw TransferableException(
      "$subject for '$expectedTag' expected a non-empty '__blocks' tag",
    );
  }
  if (tag != expectedTag) {
    throw TransferableException(
      "$subject expected tag '$expectedTag', got '$tag'",
    );
  }
  return json;
}

/// The [field] of a transferable [descriptor] for [tag] that the client
/// can't work without. Throws an [InvalidDescriptorException] naming [field]
/// when it is missing or is not a [T], instead of the `TypeError` of a cast.
///
/// Not exported: the package's descriptor errors are raised here and in
/// [validateTransferableDescriptor].
T requireDescriptorField<T extends Object>(
  Map<String, dynamic> descriptor,
  String field, {
  required String tag,
  String subject = 'Transferable',
}) {
  final value = descriptor[field];
  if (value is T) return value;
  if (value == null) {
    throw InvalidDescriptorException(
      "$subject for '$tag' is missing the required field '$field'",
      blocksType: tag,
      missingField: field,
    );
  }
  throw InvalidDescriptorException(
    "$subject for '$tag' expected '$field' to be a $T, got "
    '${value.runtimeType}',
    blocksType: tag,
    missingField: field,
  );
}
