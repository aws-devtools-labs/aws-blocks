# aws-blocks-kotlin

## 0.3.0

### Minor Changes

- [#103](https://github.com/aws-devtools-labs/aws-blocks/pull/103) [`a8f486e`](https://github.com/aws-devtools-labs/aws-blocks/commit/a8f486e81d104eebe5cc5640cb32617f89f09720) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Bump Kotlin version to 2.2.10

- [#103](https://github.com/aws-devtools-labs/aws-blocks/pull/103) [`a8f486e`](https://github.com/aws-devtools-labs/aws-blocks/commit/a8f486e81d104eebe5cc5640cb32617f89f09720) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Add ability to clear cookies

### Patch Changes

- [#103](https://github.com/aws-devtools-labs/aws-blocks/pull/103) [`a8f486e`](https://github.com/aws-devtools-labs/aws-blocks/commit/a8f486e81d104eebe5cc5640cb32617f89f09720) Thanks [@mattcreaser](https://github.com/mattcreaser)! - Fix handling of keychain in the iOS runtime

- [#567](https://github.com/aws-devtools-labs/aws-blocks/pull/567) [`1f2ef9c`](https://github.com/aws-devtools-labs/aws-blocks/commit/1f2ef9c77a8548b95720aa2a17dbec39a5856192) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - Add a build-time version constant and user-agent token to the runtime

- [#598](https://github.com/aws-devtools-labs/aws-blocks/pull/598) [`a3ef0cc`](https://github.com/aws-devtools-labs/aws-blocks/commit/a3ef0ccb8b95fca28cc08a034b6b47ffbfa87fe3) Thanks [@VarshithaPamisetty](https://github.com/VarshithaPamisetty)! - Send the aws-blocks-kotlin user-agent token on outbound runtime requests

- [#551](https://github.com/aws-devtools-labs/aws-blocks/pull/551) [`028ce4f`](https://github.com/aws-devtools-labs/aws-blocks/commit/028ce4f8e411314e28606fbb62e0f27feeb85331) Thanks [@ikenyal](https://github.com/ikenyal)! - Generate serializers for transferable fields in operation-scoped nested types.

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
