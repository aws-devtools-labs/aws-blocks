/// How a name from the spec becomes a Dart identifier. Shared by the builder,
/// which names the generated types, and the generator, which names their
/// members, the operations' parameters, the namespaces, the servers and the
/// enum values. Not exported: it is an implementation detail of both.
library;

/// Dart's reserved words and built-in identifiers. A name equal to one of
/// these gets a trailing `$` (`class$`).
const dartKeywords = {
  'abstract',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'covariant',
  'default',
  'deferred',
  'do',
  'dynamic',
  'else',
  'enum',
  'export',
  'extends',
  'extension',
  'external',
  'factory',
  'false',
  'final',
  'finally',
  'for',
  'Function',
  'get',
  'hide',
  'if',
  'implements',
  'import',
  'in',
  'interface',
  'is',
  'late',
  'library',
  'mixin',
  'new',
  'null',
  'on',
  'operator',
  'part',
  'required',
  'rethrow',
  'return',
  'sealed',
  'set',
  'show',
  'static',
  'super',
  'switch',
  'sync',
  'this',
  'throw',
  'true',
  'try',
  'typedef',
  'var',
  'void',
  'while',
  'with',
  'yield',
};

/// Types and functions the generated library refers to by name. A member
/// or a parameter with one of these names shadows it for the rest of its
/// scope (`final int int;` makes every later `int` the field), and a
/// generated type with one of these names shadows it in the whole library
/// (`class String` breaks every `Map<String, dynamic>`), so such a name is
/// escaped wherever it appears, whether or not that scope uses the name.
const referencedNames = {
  'ArgumentError',
  'BlocksClient',
  'FileDownloadHandle',
  'FileUploadHandle',
  'Future',
  'List',
  'Map',
  'MapEntry',
  'Object',
  'OidcClient',
  'RealtimeChannel',
  'RegExp',
  'SessionStore',
  'String',
  'UnknownTransferable',
  'Uri',
  'bool',
  'double',
  'int',
  'num',
};

/// The top-level functions and constants the generated code calls, and the
/// two classes it always declares. A generated type with one of these names
/// would shadow or duplicate it (`class override` breaks every `@override`).
const generatedTopLevelNames = {
  'Blocks',
  'Servers',
  'blocksDeepEquals',
  'blocksDeepHash',
  'identical',
  'override',
};

final _identifier = RegExp(r'^[a-zA-Z_$][a-zA-Z0-9_$]*$');
final _separators = RegExp(r'[^a-zA-Z0-9$]+');

/// [name] in characters a Dart identifier can hold. A name that already is
/// an identifier is returned as is. Any other is split at each run of other
/// characters (`-`, `.`, a space, `_`, `'`, …) and camel-cased: every part
/// after the first is capitalized (`content-type` is `contentType`, `a.b` is
/// `aB`, `Get-item` is `GetItem`). A result that is empty or starts with a
/// digit gets a leading `_` (`1st` is `_1st`), which [dartIdentifiers] then
/// makes public.
String sanitizeIdentifier(String name) {
  if (_identifier.hasMatch(name)) return name;
  final parts = name.split(_separators);
  final result =
      parts.first +
      parts
          .skip(1)
          .map((p) => p.isEmpty ? '' : p[0].toUpperCase() + p.substring(1))
          .join();
  if (result.isEmpty || !RegExp(r'^[a-zA-Z_$]').hasMatch(result)) {
    return '_$result';
  }
  return result;
}

/// The Dart identifier for each of [names]: names from the spec that share
/// one scope (a class's fields, an operation's parameters, the namespaces,
/// the library's types, …), keyed by the name. This is the one place a spec
/// name becomes an identifier; the name on the wire stays the original.
///
/// A name is used as is unless Dart can't take it there:
///
/// - [sanitize] (by default [sanitizeIdentifier]) first turns it into
///   identifier characters: `content-type` is `contentType`.
/// - A leading `_` would make it library-private (and a named parameter
///   can't start with `_`), so each leading `_` becomes `$`: `_id` is
///   `$id`, `__v` is `$$v`.
/// - A Dart keyword ([dartKeywords]), a name the generated code refers to
///   ([referencedNames]), or one of [reserved] (the scope's own members,
///   the library's other top-level names) gets a trailing `$`: `class$`,
///   `int$`, `toJson$`.
///
/// A name whose identifier is the name itself claims it first. Any other
/// that lands on an identifier already taken, or on one of [reserved], gets
/// more `$`s, so no two names share one, in the order of [names]. Every name
/// that is already a usable identifier is unchanged, so existing output is
/// too.
Map<String, String> dartIdentifiers(
  Iterable<String> names, {
  Set<String> reserved = const {},
  String Function(String) sanitize = sanitizeIdentifier,
}) {
  final ids = <String, String>{};
  final changed = <String, String>{};
  for (final name in names) {
    final base = sanitize(name);
    final private = RegExp('^_+').stringMatch(base)?.length ?? 0;
    final id = private > 0
        ? '\$' * private + base.substring(private)
        : dartKeywords.contains(base) ||
              referencedNames.contains(base) ||
              reserved.contains(base)
        ? '$base\$'
        : base;
    if (id == name) {
      ids[name] = id;
    } else {
      changed[name] = id;
    }
  }
  final taken = ids.values.toSet();
  for (final MapEntry(key: name, value: id) in changed.entries) {
    var unique = id;
    while (reserved.contains(unique) || !taken.add(unique)) {
      unique = '$unique\$';
    }
    ids[name] = unique;
  }
  return ids;
}
