# Fixture stub modules

Compile-only stand-ins for the Swift modules that codegen fixtures declare through
`x-blocks-native-packages` / `x-blocks-native-bindings` (fixture
`27-declared-transferable-bindings`). `compile-fixture-goldens.sh` builds each
`<fixture>/<Module>.swift` here as module `<Module>` and links the fixture's
golden against it, so a golden that imports a declared module still compiles.

Each type exposes only the `blocks-transferable-v1` factory the generated client
calls: `X.fromBlocksDescriptor(descriptor)` for generic arity 0, and
`X<T>.fromBlocksDescriptor(descriptor) { data in … }` for arity 1, where the
closure decodes the payload. They do nothing at run time.
