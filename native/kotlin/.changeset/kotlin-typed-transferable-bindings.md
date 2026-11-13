---
"aws-blocks-kotlin": minor
---

Generate the declared type and factory call for a bound transferable result

A direct method result whose tag is bound by `x-blocks-native-bindings` now returns the declared
package type, hydrated through its `fromBlocksDescriptor` factory after the descriptor is checked
by the new public `validateTransferableDescriptor`. A bound package with no android field, or one
listed in the new `awsBlocks { excludeNativePackages }` property, keeps the UnknownTransferable
fallback; a binding on a built-in tag is ignored and the runtime type still wins; a declared
package no binding references reports `AWSBLOCKS-NATIVE-003`.

**A nullable bound result now returns null for a JSON-null body.** For the four built-in tags the
generated method already declared the nullable type and called the factory unconditionally, so a
null body threw IllegalArgumentException — from the jsonObject cast for the realtime and
file-bucket tags, and from the OidcClientConfig deserializer for `oidc/client`. A caller that
relied on that throw now receives null. A nullable result on a declared binding previously failed
code generation, so it has no prior behaviour. Both catalogs were previously ignored wholesale, so
any malformed one is now a spec error, and a rejected spec leaves the previously generated sources
in place.

Every spec a run refuses now shares one `CodegenException` base, which `OpenRpcParseException`
extends. The generator's three rejections moved to it from `UnsupportedOperationException`, so a
caller catching that type for an unbound or non-direct transferable must catch the base instead.

`KotlinCodeGenerator` takes a new optional `excludedPackages` parameter, and `RpcModel` and
`CodegenModel` carry the new `NativeCatalogs`. The parameters are defaulted, so source
compatibility holds, but the previous constructor and copy overloads are gone from the bytecode
and callers must recompile.
