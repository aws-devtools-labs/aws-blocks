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
