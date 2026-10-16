/// Value equality for JSON-shaped data, used by generated models' `==`.
///
/// Dart's [List] and [Map] compare by identity, so two models decoded from the
/// same JSON aren't `==` if either holds a list or map. Generated models
/// compare such fields with [blocksDeepEquals] and hash them with
/// [blocksDeepHash] instead.
///
/// Lists are equal when they have the same length and equal elements in the
/// same order; maps when they have the same keys and equal values, in any
/// order. Both recurse into nested lists and maps. Any other value, including
/// a generated model, is compared with its own `==`, so a list of models is
/// equal when the models are. A Dart record (a generated tuple) also uses its
/// own `==`, which compares a list or map inside it by identity.
bool blocksDeepEquals(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is List<Object?> && b is List<Object?>) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!blocksDeepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (a is Map<Object?, Object?> && b is Map<Object?, Object?>) {
    if (a.length != b.length) return false;
    for (final entry in a.entries) {
      if (!b.containsKey(entry.key)) return false;
      if (!blocksDeepEquals(entry.value, b[entry.key])) return false;
    }
    return true;
  }
  return a == b;
}

/// A hash code consistent with [blocksDeepEquals]: values it treats as equal
/// hash the same.
///
/// A list hashes its elements in order and a map hashes its entries in any
/// order, both recursively. Any other value uses its own `hashCode`.
int blocksDeepHash(Object? value) {
  if (value is List<Object?>) {
    return Object.hashAll(value.map(blocksDeepHash));
  }
  if (value is Map<Object?, Object?>) {
    return Object.hashAllUnordered(
      value.entries.map(
        (e) => Object.hash(e.key.hashCode, blocksDeepHash(e.value)),
      ),
    );
  }
  return value.hashCode;
}
