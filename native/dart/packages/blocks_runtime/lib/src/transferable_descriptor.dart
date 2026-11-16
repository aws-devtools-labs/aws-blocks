/// Throws a [FormatException] unless [json] is an object whose `__blocks` is a
/// non-empty string equal to [expectedTag]; returns that same instance, not a
/// copy, so the caller owns any copying it needs.
Map<String, dynamic> validateTransferableDescriptor(
  Object? json, {
  required String expectedTag,
  String subject = 'Transferable',
}) {
  if (json is! Map<String, dynamic>) {
    throw FormatException(
      "$subject for '$expectedTag' expected a JSON object descriptor",
    );
  }
  final tag = json['__blocks'];
  if (tag is! String) {
    throw FormatException(
      "$subject for '$expectedTag' expected a string '__blocks' tag",
    );
  }
  if (tag.isEmpty) {
    throw FormatException(
      "$subject for '$expectedTag' expected a non-empty '__blocks' tag",
    );
  }
  if (tag != expectedTag) {
    throw FormatException("$subject expected tag '$expectedTag', got '$tag'");
  }
  return json;
}

/// The [field] of a transferable [descriptor] for [tag] that the client
/// can't work without. Throws a [FormatException] naming [field] when it is
/// missing or is not a [T], as [validateTransferableDescriptor] does for the
/// tag, instead of the `TypeError` of a cast.
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
    throw FormatException(
      "$subject for '$tag' is missing the required field '$field'",
    );
  }
  throw FormatException(
    "$subject for '$tag' expected '$field' to be a $T, got "
    '${value.runtimeType}',
  );
}
