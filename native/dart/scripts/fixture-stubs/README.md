# Fixture stub packages

Compile-only stand-ins for the native packages that codegen fixtures declare
through `x-blocks-native-packages` / `x-blocks-native-bindings` (fixture
`27-declared-transferable-bindings`). `analyze-fixture-goldens.sh` adds each
directory here as a path dependency of its scratch package, so a golden that
imports a declared package's type still analyzes.

Each type exposes only the `blocks-transferable-v1` factory the generated
client calls: `X.fromBlocksDescriptor(descriptor)` for generic arity 0, and
`X<T>.fromBlocksDescriptor(descriptor, decode)` for arity 1, where `decode`
receives the payload as a `Map<String, dynamic>`.
