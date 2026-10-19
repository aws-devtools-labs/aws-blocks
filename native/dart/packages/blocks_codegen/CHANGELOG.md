## Unreleased

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
