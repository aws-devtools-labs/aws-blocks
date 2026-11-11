/// Identifiers for names the spec supplies.
library;

final _nonIdentifierChar = RegExp(r'[^A-Za-z0-9_]');
final _onlyUnderscores = RegExp(r'^_*$');

/// The identifier generated code uses for a name the spec supplies.
///
/// Every character outside `[A-Za-z0-9_]` becomes `_`. A name left empty or
/// holding only underscores gains `unnamed`, and a result that opens with a
/// digit or an underscore gains a leading `$`: Dart makes a leading underscore
/// library-private, which a named parameter cannot be, so a name the spec
/// itself opens with `_` gains the `$` too (`_x` becomes `$_x`). Any other
/// name the spec already spells as an identifier is returned unchanged.
///
/// Every name the spec supplies reaches generated code through this function,
/// so an identifier can only ever hold the characters above, whatever the spec
/// holds; the spec's own text reaches generated code only as an escaped string
/// literal.
String safeDartIdentifier(String name) {
  final mapped = name.replaceAll(_nonIdentifierChar, '_');
  if (_onlyUnderscores.hasMatch(mapped)) return '\$${mapped}unnamed';
  final first = mapped.codeUnitAt(0);
  final opensWithDigit = first >= 0x30 && first <= 0x39;
  final opensWithUnderscore = first == 0x5f;
  return opensWithDigit || opensWithUnderscore ? '\$$mapped' : mapped;
}
