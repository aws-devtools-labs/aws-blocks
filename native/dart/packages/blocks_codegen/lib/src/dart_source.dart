/// `extension type` must precede `extension`: alternation is first-match, so
/// reversing them captures `type` as the declaration's name.
final _typeDeclaration = RegExp(
  r'^(?:abstract |final |sealed |base |interface |mixin )*'
  r'(?:class|enum|mixin|extension type|extension|typedef)\s+(\w+)',
  multiLine: true,
);

Set<String> declaredTypeNames(String source) =>
    _typeDeclaration.allMatches(source).map((m) => m.group(1)!).toSet();
