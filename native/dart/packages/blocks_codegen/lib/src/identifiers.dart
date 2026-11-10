/// Identifiers for names the spec supplies.
library;

final _nonIdentifierChar = RegExp(r'[^A-Za-z0-9_]');
final _onlyUnderscores = RegExp(r'^_*$');

/// The identifier generated code uses for a name the spec supplies.
///
/// Every character outside `[A-Za-z0-9_]` becomes `_`. A name left empty or
/// holding only underscores gains `unnamed`, and a result that opens with a
/// digit, or with an underscore the spec did not write, gains a leading `$`:
/// Dart makes a leading underscore library-private, which a named parameter
/// cannot be. A name the spec already spells as an identifier, including one
/// the spec itself opens with `_`, is returned unchanged.
///
/// Every name the spec supplies reaches generated code through this function,
/// so an identifier can only ever hold the characters above, whatever the spec
/// holds; the spec's own text reaches generated code only as an escaped string
/// literal.
String safeDartIdentifier(String name) {
  final mapped = name.replaceAll(_nonIdentifierChar, '_');
  if (_onlyUnderscores.hasMatch(mapped)) return '\$${mapped}unnamed';
  final opensWithDigit =
      mapped.codeUnitAt(0) >= 0x30 && mapped.codeUnitAt(0) <= 0x39;
  final addedUnderscore = mapped.startsWith('_') && !name.startsWith('_');
  return opensWithDigit || addedUnderscore ? '\$$mapped' : mapped;
}
