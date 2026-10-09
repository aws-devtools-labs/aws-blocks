## Unreleased

- Fix generated calls that sent an argument to the wrong parameter. A call
  sent its arguments as a by-name map that left out unset optionals, but an
  AWS Blocks server reads params by position (a map by its values, in order),
  so `echoArgs(first: 'a', last: 'c')` reached the server with `middle = 'c'`.
  Calls now send a positional array, as the TypeScript and Kotlin clients do:
  arguments in the method's parameter order, `null` in the slot of a left-out
  optional that comes before a set or required argument, and trailing
  left-out optionals omitted. A method without parameters sends `[]`.
  Generated clients need the `blocks_runtime` of this release, whose
  `BlocksClient.call` accepts a list.
- Generate `UnknownTransferable` (with an `AWSBLOCKS-NATIVE-001` diagnostic) for
  a direct result whose transferable tag has no known binding, instead of `dynamic`.
- A nullable or optional `unknown` value now generates as `dynamic` instead of
  `dynamic?` (`dynamic` already admits null), so generated clients no longer
  trigger the `unnecessary_question_mark` warning.
- Fix generated clients that didn't compile:
  - A length, pattern, or range constraint on an optional (or nullable) model
    field is now checked on a non-null local, instead of an inline null check
    the analyzer rejects (`unchecked_use_of_nullable_value`).
  - A realtime channel, file download, or file upload inside a model is now
    hydrated in the model's `fromJson`, instead of the raw descriptor being
    passed where a `RealtimeChannel<…>` or file handle was expected.
  - A realtime channel whose message type isn't an object (a list, primitive,
    enum, map, nullable, or `unknown`) now decodes each message with
    `RealtimeChannel.fromJsonValue`, instead of generating `List<String>.fromJson`.
    An object message type (a model or union, directly or through `$ref`)
    still decodes with `fromJson`. Every channel message type is hydrated, so
    no channel is returned as its raw descriptor.
- Fix a model field holding a map of objects or enums (`Map<String, Customs>`):
  each value is now decoded through its `fromJson`, instead of a cast that
  threw at runtime.
- Fix generated clients that compiled but threw at runtime on a container
  (list, map, nullable, tuple, or any nesting of them) whose elements need
  converting. Every element now decodes through its own decoder, in model
  fields, additional properties and operation results alike:
  - A list or map of realtime channels or file handles
    (`List<RealtimeChannel<Note>>`) hydrates each one, instead of
    `.cast<RealtimeChannel<Note>>()`.
  - A map of lists (`Map<String, List<String>>`, `Map<String, List<Note>>`),
    a list of maps or lists of models, a list of nullable models, and a list
    of tuples decode each element, instead of a cast such as
    `v as List<String>`.
  - A list of enums (`List<Level>`) decodes each value through `fromJson`,
    instead of `.cast<Level>()`. This affected the `Auth` block's signed-in
    user's `groups` and its sign-in steps' `allowedMFATypes` and
    `availableChallenges`. A list of enums declared under
    `components/schemas` also compiles now.
- An `oidc/client` inside a model is now hydrated. A model (or union) that
  holds one at any depth takes the calling client as a second argument,
  `fromJson(json, client)`, which the generated operations pass. Other
  models keep their one-argument `fromJson`.
- `toJson()` now returns plain JSON for containers of models and enums
  (`Map<String, List<Note>>`, `List<Level>`), and parameters are encoded the
  same way, so `X.fromJson(x.toJson())` round-trips. What is sent over the
  wire is unchanged.
- A generated model's `==` and `hashCode` now compare list and map fields
  (and `unknown` values, which hold any JSON) by value, using the runtime's
  `blocksDeepEquals` and `blocksDeepHash`. Before, they compared them by
  identity, so two models decoded from the same JSON weren't equal if they had
  a list or map field. Nested lists and maps, and the models inside them,
  compare by value too; a map's key order doesn't matter. Other fields are
  unchanged. Realtime channels, file handles and OIDC clients are live objects
  and still compare by identity, as does a list or map inside a tuple.
- The generated library now re-exports `RealtimeChannel`, `FileDownloadHandle`
  and `FileUploadHandle` (and the OIDC types, for an `oidc/client`) whenever
  its models or operations use one at any depth, such as a channel inside a
  model or a list of file handles. Before, it only did so when the
  transferable was a top-level type or an operation's direct result, so a
  client had to import `blocks_runtime` to name the type.
- Fix generated clients where a name from the spec collided with a name the
  generated code declares. No name from the spec changes, and output without
  such a name is unchanged:
  - An operation parameter named `result` or `params` didn't compile (the
    method's own `result` / `params` local shadowed it). The local is now
    `$result` / `$params` in that method only.
  - A model or union variant field named `other` compiled, but `==` compared
    the other object with its own field (`other == other.other`), so it was
    never equal. Its `==` parameter is now `$other` in that class only.
  - A namespace named `client`, `baseUrl` or `sessionStore` didn't compile:
    `Blocks`' constructor assigned it to its own `client` local or to its
    `baseUrl` / `sessionStore` parameter. The constructor keeps those
    parameters and now assigns such a namespace through `this.`, and its
    local is `$client` when a namespace is named `client`.
- Fix generated clients that didn't compile when a `$ref` pointed at a
  component schema that isn't an object, an enum or a discriminated union: a
  string, number, array, map or nullable, another such `$ref`, or a union
  generated as `dynamic` (such as one discriminated by `const`). The `$ref`
  named a Dart type that was never generated (`final Shape one`,
  `Shape.fromJson(…)`); it is now typed, decoded and encoded as the schema's
  own type (`final String id`, `final List<Note> notes`, `final dynamic one`),
  as an inline schema is. A schema that refers to itself through such types
  only (`Loop: array of $ref Loop`) is `dynamic`; before, generating it
  overflowed the stack.
- Fix generated clients that didn't compile, or hid a field, when a name from
  the spec can't be a Dart identifier as it is. Such a name is now escaped,
  as a keyword already was (`class$`). Its JSON key is unchanged, and so is
  every other name:
  - A name starting with `_` was library-private, so a field such as `_id`
    couldn't be read outside the generated library, and a parameter named
    `_id` didn't compile. Each leading `_` is now `$`: `_id` is `$id`, `__v`
    is `$$v`. This also applies to operations, namespaces (including
    `_default`, which holds methods with no namespace), servers and enum
    values, including an enum value that starts with a digit (`1st` is
    `$1st`, instead of the private `_1st`).
  - A field named after a member the generated class has (`toJson`,
    `fromJson`, `hashCode`, `toString`, `runtimeType`, `noSuchMethod`, or
    `additionalProperties` in a model that has additional properties) is now
    `toJson$` and so on. An operation, namespace or server named after an
    `Object` member is escaped the same way.
  - An enum value named `values`, `index` or `name` (or after any of the
    members above) is now `values$` and so on. A keyword enum value, such as
    `class`, is now `class$`; before, the enum didn't compile.
  - A field, parameter, operation or enum value named after a type the
    generated code uses (`int`, `String`, `bool`, `List`, `Map`, `Object`, …,
    or a model's own name) shadowed that type and is now `int$` and so on.
  - Two enum values that become the same identifier (`a-b` and `aB`) now get
    different ones (`aB$` and `aB`).
- Fix union variants that are open records (an arm with `properties` and
  `additionalProperties`, TypeScript `{ action: 'signUp'; … } &
  Record<string, string>`): their extra keys were dropped. The variant now has
  an `additionalProperties` map, as a model already did, decoded from every
  key that isn't one of its own or the discriminator and encoded flat beside
  them (a field named `additionalProperties` in such a variant is
  `additionalProperties$`, as in a model). This is the `Auth` block's
  `setAuthState` `signUp` action, so a Dart app can now send sign-up
  attributes:
  `SignUpInput(username: …, password: …, additionalProperties: {'email': …})`.
- An open record's `toJson()` (a model's or a variant's) no longer lets an
  `additionalProperties` entry named like one of its properties, or like the
  discriminator, overwrite the typed value; such an entry isn't sent, as in
  the Swift and Kotlin clients. A closed object is no longer merged into an
  open one of the same shape (it got an `additionalProperties` field it
  doesn't have), and two unions that differ only in a variant's extra keys
  are now separate types.
- Fix generated clients that didn't compile, or sent the wrong JSON, when a
  string from the spec holds characters Dart reads specially. Each one is
  written as an escaped string literal, so a `$` no longer interpolates and a
  `'`, `\`, newline or other control character no longer ends or breaks the
  literal. A JSON key such as `$result` interpolated: the request carried the
  value of the generated `result` variable as its key. It is now the key
  `$result`. This covers
  model and parameter keys, an open record's known keys, a union's
  discriminant and its values, enum wire values, operation names, server
  URLs, the `Unknown …` error message and the header comment. A constraint
  pattern stays a raw literal (`r'^[A-Z]{3}$'`) unless it holds a `'` or a
  control character. Output without such characters is unchanged.
- Fix generated clients that didn't compile when a name from the spec holds
  characters a Dart identifier can't, or when a generated type would be
  private or shadow a type the library uses. The JSON key and the operation's
  wire name never change, and every name that is already a usable identifier
  is unchanged:
  - A field, parameter, operation, namespace or server name such as
    `content-type`, `x.y z` or `it's` is camel-cased across those characters:
    `contentType`, `xYZ`, `itS`. Before, only enum values were. A dotted
    namespace `a.b` is the `Blocks` field `aB` of class `ABApi`; before, it
    generated `class A.bApi`. Names that become the same identifier in one
    scope get different ones (`contentType` and `contentType$`).
  - A type named after a schema, field, operation or discriminant value is a
    valid identifier too (`my-doc` is `myDoc`, a field `meta-data` gives
    `DocMetaData`, a union arm `in-progress` gives `InProgressTask`), and is
    renamed in every place the type is used.
  - A namespace starting with `_` generated a library-private class
    (`_xApi`, and `_defaultApi` for methods with no namespace), so a caller
    couldn't name the type of `blocks.$x`. It is now `$xApi` / `$defaultApi`,
    and a type or union arm starting with `_` is `$…` the same way.
  - A schema named after a type the generated code uses (`String`, `Map`,
    `Object`, `List`, `int`, …) or a name it declares or calls (`Blocks`,
    `Servers`, `override`, `identical`) shadowed it in the whole library. It
    is now `String$` and so on. A namespace class that a schema already has
    the name of (`TodosApi`) is now `TodosApi$`.
- Fix generated clients that threw `JsonUnsupportedObjectError` when a call
  sent a realtime channel, a file handle or an OIDC client back to the server:
  as a parameter, or inside a model, list, map, tuple or union variant the
  call sends. Each one is now sent as its `{"__blocks": …}` descriptor, the
  JSON the server sent it as, through the runtime type's new `toJson()`. A
  model's `toJson()` encodes them the same way, so `X.fromJson(x.toJson())`
  round-trips a model that holds one. A transferable with no runtime binding
  is typed `dynamic`, holds its descriptor already, and is sent as is.
  Requires `blocks_runtime` with `toJson()` on those types.
- Fix generated clients that named an undeclared type, or the wrong type,
  for a `$ref` to a component schema the generator renamed. A `$ref` now
  follows every rename:
  - A schema object whose one field has a generic shape (`{value}`,
    `{items}`, `{url}`, `{count}`, `{success}`) is generated as
    `ValueResult` and so on, but a `$ref` to it still named the schema
    (`Wrapper`), which was never declared.
  - When two different types claimed one name and were suffixed
    (`MakeResult2`, with a naming-conflict warning), a `$ref` to a schema
    that was suffixed kept naming the base type: another type, which could
    compile with the wrong fields.
  - In the same case, a schema that isn't an object, an enum or a union
    (`UserId: string`, an array or map, another such `$ref`) was dropped,
    so a `$ref` to it named an undeclared `UserId`.
  - A nullable object schema (`oneOf: [{type: object, …}, {type: null}]`)
    lost its class, or, with such a naming conflict, its `?`. It is now its
    class, nullable where it is used (`MaybeBox?`).
- Hydrate a nullable bound transferable result (`RealtimeChannel<T>?`,
  `FileDownloadHandle?`, `FileUploadHandle?`, `OidcClient?`) through its
  `fromJson`, behind a `== null` guard, instead of leaving it as a raw map.

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
