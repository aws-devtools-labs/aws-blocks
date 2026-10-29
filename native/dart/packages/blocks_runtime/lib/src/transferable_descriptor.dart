/// A transferable's `{"__blocks": tag, …}` descriptor for `toJson()`: a deep
/// copy of [descriptor], the JSON it was hydrated from, led by [tag] when the
/// descriptor names none. Key order is kept, so a descriptor the server sent
/// encodes byte for byte as it arrived. A copy, so a caller changing the
/// result doesn't change the transferable.
Map<String, dynamic> transferableDescriptor(
  String tag,
  Map<String, dynamic> descriptor,
) => {'__blocks': tag, ..._copyJsonMap(descriptor)};

Map<String, dynamic> _copyJsonMap(Map<String, dynamic> map) => {
  for (final e in map.entries) e.key: _copyJson(e.value),
};

Object? _copyJson(Object? value) => switch (value) {
  final Map<String, dynamic> map => _copyJsonMap(map),
  final List<dynamic> list => [for (final e in list) _copyJson(e)],
  _ => value,
};

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
