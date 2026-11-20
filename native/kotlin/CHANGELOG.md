# aws-cdk-blocks-kotlin

## 1.0.0

First stable release of AWS CDK Blocks for Kotlin.

### Breaking

- The Gradle plugin's extension, tasks and types are renamed from `AwsBlocks` to
  `CdkBlocks`: configure it with `cdkBlocks { }`, and the codegen tasks are
  `cdkBlocksCodegen<Variant>` and `cdkBlocksDumpModel`. Inside the extension,
  `oidc { redirectUrl }` is renamed `relayTo`, matching the backend's
  `allowedRelayOrigins`.
- The generated `Api(server: BlocksServer = Servers.local)` constructor is gone. Build a
  `Blocks` instance and take the API from it: `Api()` becomes `Blocks().api`, and
  `Api(server = s)` becomes `Blocks(s).api`. One `Blocks` serves every API over a single
  HTTP engine, so keep the instance and `close()` it when done.
- One error taxonomy, shared with the Swift and Dart clients: every exception extends
  `BlocksException`. Transport failures are `TransportException` (was
  `NetworkException`). `ApiException` replaces `code` and `data` with `status`, `name`
  and `retriable` — match errors by `name` with the new `isBlocksError`.
  `TransferableIOException` is now `FileTransferException`. A JSON-RPC error arriving
  with a non-2xx HTTP status throws the same `ApiException` as one arriving with
  HTTP 200.
- Each API namespace is called at its own path, `{url}/{namespace}`, instead of the
  shared `/cdk-blocks/api`. Deploy the backend with `@aws-blocks/core` 0.8.0 or later,
  or any `@aws-cdk-blocks/core`, before shipping an app built with this version: an
  older backend serves only the shared path and rejects the per-namespace one. A proxy
  in front of the API must forward the whole `/cdk-blocks/api/*` subtree.
- Generated clients and the codegen defaults use the `/cdk-blocks/api` and
  `/cdk-blocks/auth/*` paths. A server URL still configured with `/aws-blocks/api` keeps
  working; a bare origin does not, so append `/cdk-blocks/api` to a `servers {}` override
  such as `local("http://10.0.2.2:3001")`. A `servers {}` URL that reaches no RPC is
  rejected, and the unused `x-blocks-endpoint` spec key is dropped.
- Unions and string enums that a response can carry are open: an arm or value a newer
  backend adds decodes to an unknown variant instead of throwing
  `SerializationException`, so an exhaustive `when` needs that branch. Such an enum is
  now a sealed class rather than a Kotlin `enum class`: use `value` and `fromValue` in
  place of `name` and `valueOf`, and `entries` in place of `values()`. `ordinal`,
  `EnumSet` and comparisons no longer apply.
- On the JVM, set `BlocksConfig.applicationId` to keep the session across restarts.
  0.2.0 always persisted to `~/.blocks`; without an `applicationId` the session is now
  held in memory and is gone when the process exits, with no error. The cookie jar also
  moved to a single stored entry with no fallback read, so every signed-in user on
  Android, iOS and the JVM signs in once more after upgrading.
- `OidcClient` is typed by the spec's provider names, so a provider a method does not
  declare no longer compiles.
- `OidcClient.signOut()` throws when the backend refuses the sign-out.
- A realtime subscription that ends throws instead of going quiet.
- Built with Kotlin 2.2.21 (0.2.0: 2.1.21), and depends on kotlinx-serialization-json
  1.9.0 (was 1.7.3) and Ktor 3.3.3 (was 3.1.3), which brings OkHttp 5 on JVM and
  Android.

### Other changes

- Add OIDC sign-in on iOS and JVM. iOS uses `ASWebAuthenticationSession`; the JVM
  receives the relay on a loopback address it binds per sign-in, so desktop apps need no
  relay configuration, and its landing pages are configurable. The JVM holds its session
  encryption key in the operating system.
- Add `OidcClient.restore()`, which reads the backend's session for the client's cookie,
  and `OidcUser` gains the optional fields an `Auth` block reports.
- Generated clients hydrate transferables inside lists, maps and models, accept a
  `$ref`, emit the declared type and factory call for a bound transferable result, and
  produce `UnknownTransferable` for a tag with no binding. Codegen reports a declared
  binding it cannot apply, and warns when `excludeNativePackages` names a package the
  spec does not declare.
- Set default HTTP timeouts of 30 s connect and 60 s socket.
- Hold the Android credential store on an Android Keystore key, and pin
  `androidx.security:security-crypto` to the stable `1.1.0`.
- Store the iOS cookie jar with a this-device-only Keychain accessibility class, and
  check the result of the system random number generator.
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
  requires, the RPC, OIDC and file-transfer exceptions, that an upload to a handle
  signed with a content length must send exactly that length, and how the JVM cookie
  store keeps its encryption key. The Android and multiplatform examples point at the
  shared backend setup and explain how to use the stub identity provider for testing.
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
