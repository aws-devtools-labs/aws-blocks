# aws-cdk-blocks-kotlin

## 1.0.0

First stable release of AWS CDK Blocks for Kotlin.

### Breaking

- The Gradle plugin's extension, tasks and types are named `CdkBlocks`. Configure the
  plugin with `cdkBlocks { }`.
- `cdkBlocks.oidc.redirectUrl` is removed; use `relayTo`, which matches the backend's
  `allowedRelayOrigins`.
- Generated clients and the codegen defaults use the `/cdk-blocks/api` and
  `/cdk-blocks/auth/*` paths. A server URL still configured with `/aws-blocks/api`
  keeps working.
- Each API namespace is called at its own RPC path.
- A `servers {}` URL that reaches no RPC is rejected, and the unused
  `x-blocks-endpoint` spec key is dropped.
- One error taxonomy, shared with the Swift and Dart clients: every exception extends
  `BlocksException`. Backend errors are `ApiException`; transport failures are
  `NetworkException`. A JSON-RPC error arriving with a non-2xx HTTP status now throws
  the same `ApiException` as one arriving with HTTP 200.
- Unions and string enums that a response can carry are open: an arm or value a newer
  backend adds decodes to an unknown variant instead of throwing
  `SerializationException`, so an exhaustive `when` needs that branch.
- `OidcClient` is typed by the spec's provider names, so a provider a method does not
  declare no longer compiles.
- `OidcClient.signOut()` throws when the backend refuses the sign-out.
- A realtime subscription that ends throws instead of going quiet.
- A binding export may contain `.`, and two bindings claiming one type is a generation
  error naming both.
- Built with Kotlin 2.2.10.

### Other changes

- Add a `Blocks` entry point, so one HTTP engine serves every API.
- Add OIDC sign-in on iOS and JVM. iOS uses `ASWebAuthenticationSession`; the JVM
  receives the relay on a loopback address it binds per sign-in, so desktop apps need
  no relay configuration, and its landing pages are configurable. The JVM holds its
  session encryption key in the operating system.
- Add `OidcClient.restore()`, which reads the backend's session for the client's
  cookie, and `OidcUser` gains the optional fields an `Auth` block reports.
- Generated clients hydrate transferables inside lists, maps and models, accept a
  `$ref`, emit the declared type and factory call for a bound transferable result, and
  produce `UnknownTransferable` for a tag with no binding.
- Add cookie clearing.
- Each application gets its own storage on the JVM.
- Set default HTTP timeouts of 30 s connect and 60 s socket.
- Hold the Android credential store on an Android Keystore key, and pin
  `androidx.security:security-crypto` to the stable `1.1.0`.
- Store the iOS cookie jar with a this-device-only Keychain accessibility class, and
  check the result of the system random number generator.
- Report a declared binding codegen cannot apply, and warn when
  `excludeNativePackages` names a package the spec does not declare.
- Generated clients compile and round-trip across the whole schema surface: unions with
  no discriminator or a boolean one, tuples, self-referencing types, objects with no
  properties, inline-object properties, `format: uuid`, `unknown` fields, additional
  properties, names that collide, type names that are valid files on Windows, and
  escaped schema-controlled strings.
- Cookie storage no longer loses, over-sends or shares cookies.
- Raw routes resolve against the server URL cut at its first `cdk-blocks` or
  `aws-blocks` path segment.
- Send an `aws-blocks-kotlin` user-agent token on outbound requests.
- Document the `org.jetbrains.kotlin.plugin.serialization` plugin the Gradle plugin
  requires, that an upload to a handle signed with a content length must send exactly
  that length, and how the JVM cookie store keeps its encryption key.
- The codegen task's "no spec found" error names the `.cdk-blocks-sandbox` config
  directory.

Thanks to @cadivus, @ekjotmultani, @harsh62, @ikenyal, @mattcreaser, @Simone319,
@soberm and @VarshithaPamisetty for their contributions to this release.

## 0.2.0

### Minor Changes

- [#74](https://github.com/aws-devtools-labs/aws-blocks/pull/74) [`9583de3`](https://github.com/aws-devtools-labs/aws-blocks/commit/9583de376098e556bf0aadca96da4f6ecd2f0f3a) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Add NetworkException for transport-level exceptions

- [#72](https://github.com/aws-devtools-labs/aws-blocks/pull/72) [`3a26371`](https://github.com/aws-devtools-labs/aws-blocks/commit/3a263715f4e70b71c8baa3a0770ec51c66242941) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Make the URL publicly accessible from a File\*Handle

### Patch Changes

- [#35](https://github.com/aws-devtools-labs/aws-blocks/pull/35) [`16b26e9`](https://github.com/aws-devtools-labs/aws-blocks/commit/16b26e9fed4192fc2aade23e24a9582a2a244381) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Fix Kotlin code generation for nullable discriminated unions

- [#71](https://github.com/aws-devtools-labs/aws-blocks/pull/71) [`9ee6dc1`](https://github.com/aws-devtools-labs/aws-blocks/commit/9ee6dc1f57934cd670138059bdcefaa60694f1b9) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Fixes code generator for nested serializers in discriminated unions. Previously, such serializers were not properly referenced in the generated code.

- [#113](https://github.com/aws-devtools-labs/aws-blocks/pull/113) [`5791535`](https://github.com/aws-devtools-labs/aws-blocks/commit/5791535b23b389f9c5148f04536032ca18d915db) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Make awsDumpCodegenModel task non-cacheable

- [#73](https://github.com/aws-devtools-labs/aws-blocks/pull/73) [`0da61d1`](https://github.com/aws-devtools-labs/aws-blocks/commit/0da61d120c0a29e1a4f039ae310f54a0dc3df0bd) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Fix RealtimeChannel throwing exception when running against a local server

## 0.1.0

Initial version
