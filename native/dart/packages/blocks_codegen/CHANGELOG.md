## Unreleased

- Sanitize every spec-derived identifier (type and variant class names, fields,
  parameters, methods, servers, enum values and discriminator keys): any
  character outside `[A-Za-z0-9_]` becomes `_`, and a name that would open with
  a digit or an underscore gains a leading `$`, so a spec name such as `_x`
  generates `$_x` and stays public. Keywords keep their trailing `$`, and an
  enum value that is a keyword, such as `default`, now gains one too. The
  original key is still the JSON key, as an escaped string literal. Two names
  that reduce to one identifier in the same scope now throw a
  `NamingConflictException` naming both, as do two discriminator values whose
  variant classes share a name (`Foo` and `foo`), and a boolean discriminator
  value other than `true` or `false` is a spec error. Names that held such
  characters change: a field `note$` generates `note_`, an enum value `1st`
  generates `$1st` instead of `_1st`, and a discriminator tag `create$`
  generates `Create_Input`.
- Ignore an `oidc/client` result's `x-blocks-type-args`, which
  `blocks-generate-spec` now fills with the app's provider names, so the
  generated `OidcClient` result is unchanged. Turning those names into an unused
  enum emits constants such as `default` or `okta:corp` that don't compile.
- Resolve a direct result's transferable tag through the spec's
  `x-blocks-native-packages` and `x-blocks-native-bindings` catalogs, emitting
  the declared import, its export in upper camel case, and
  `fromBlocksDescriptor` instead of `UnknownTransferable`. Generic arity one
  specializes the type with the generated model and passes its decoder.
- Fall back to `UnknownTransferable` for an arity-one declared binding whose
  payload has no generated decoder, since the ABI has no decoder-less call.
- Add the `native_package_opt_out` builder option and `--native-package-opt-out`
  flag, which exclude a logical package identity from binding resolution.
- Warn with `AWSBLOCKS-NATIVE-003` for a declared native package that no binding
  references, since nothing imports it.
- Warn with `AWSBLOCKS-NATIVE-004` for a binding whose `kind` schema 1 does not
  define. It was skipped in silence, so a typo in `kind` was indistinguishable
  from a binding that applied.
- **Breaking:** `NativeBinding` gains a required `id`, which the new diagnostic names.
  It is exported, so every external construction must add the field.
- **A binding entry with a missing or empty `id` is now a spec error.** The
  field was never read before, so such an entry generated.
- Warn with `AWSBLOCKS-NATIVE-006` when an opt-out names a package the spec does
  not declare. A misspelled identity used to opt nothing out in silence,
  indistinguishable from a working opt-out.
- Reject a string `pattern` constraint that is not a regular expression. It used
  to reach the generated client unchecked, compile cleanly, and then throw on the
  customer's first call.
- Point a `$ref` type argument at its schema's final name when a collision
  renames it. The reference used to keep the pre-rename name, so a specialized
  result hydrated with whichever type kept the old one.
- Emit a string `pattern` constraint as an escaped literal when it carries a
  quote or a line terminator, which a raw string cannot. Such a pattern used to
  close the literal and become a top-level declaration in the generated client.
- Capitalise each dot-separated segment of a namespace, so a method named
  `api.foo.bar` generates `ApiFooApi` and `apiFoo` instead of an identifier
  carrying a dot. Two namespaces that differ only by punctuation, and a segment
  that is not an ASCII Dart identifier, are now errors rather than declarations
  the customer's compiler rejects.
- Escape schema-controlled string values (field names, descriptions, patterns,
  enum values, discriminator tags, method names, server URLs, defaults) when
  emitting generated Dart source, so values containing special characters
  produce well-formed code and round-trip verbatim.
- Reject a declared native package named `blocks_runtime`, which would emit two
  directives for the one library every generated client already imports.
- Reject a binding whose export resolves to a `dart:core` or `dart:async` type
  name. A `show` of one of those shadows the universal import rather than
  colliding with it, so the generated client would not compile.
- Report a spec or binding error as `Error: <message>` and exit 1, matching the
  existing naming-collision path, instead of an unhandled exception and exit
  255. This also covers malformed JSON and a missing or malformed `info` or
  `methods` section, which crashed before.
- Import a declared package with a `show` of just the bound type, and reject a
  binding whose export resolves to a type name that `blocks_runtime`, another
  declared package, or the generated client itself already declares.
- Reject a declared Dart package whose `name` is not a pub package name or whose
  `library` is not a `.dart` path inside `lib/`, since both are interpolated
  into the generated import directive.
- Reject a binding whose `export` is not a delimited run of alphanumeric
  segments starting with a letter, since the generator upper-camel-cases it into
  a type name in the generated client.
- Name the accepted separators `-`, `_` and `.` in that rejection, which used to
  report only that the export does not name a public Dart type.
- Reject an export declared at two generic arities in one package, which used to
  generate `APILink` and `APILink<T>` side by side from a single `show` import.
- Escape line terminators in `info.title` and `info.version` so a spec cannot
  place a declaration in the generated file's header comment.
- Generate `UnknownTransferable` (with an `AWSBLOCKS-NATIVE-001` diagnostic) for
  a direct result whose transferable tag has no known binding, instead of `dynamic`.
- Hydrate a nullable bound transferable result (e.g. `RealtimeChannel<T>?`)
  via its `fromJson` factory instead of leaving it as a raw map.
- Hydrate a `realtime/channel` message when its type argument is an object
  (via `fromJson`) or a `Map` (decoded per value); a `dynamic`, `dynamic?`, or
  absent argument yields a live `RealtimeChannel<dynamic>` with an identity
  decoder.
- Leave a `realtime/channel` message un-hydrated when its type argument is a
  concrete primitive, list, or enum: the `Map`-only runtime cannot decode it.
  The declared `RealtimeChannel<T>` is returned as the raw descriptor map, so
  reading it throws a `_TypeError` at the call site; an `AWSBLOCKS-NATIVE-002`
  diagnostic names the operation and message type.

## 0.1.4

- Bump `blocks_runtime` to `^0.1.4`

## 0.1.3

- Minor bug fixes and improvements

## 0.1.2

- Bump dependencies and minimal Dart version

## 0.1.1

- Minor bug fixes and improvements

## 0.1.0

- Initial release
