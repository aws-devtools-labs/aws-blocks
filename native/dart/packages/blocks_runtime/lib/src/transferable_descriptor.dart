/// Throws a [FormatException] unless [json] is an object whose `__blocks` is a
/// non-empty string equal to [expectedTag]; returns it unchanged otherwise.
///
/// [subject] names the failing value in the message; `UnknownTransferable`
/// passes its own name.
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
