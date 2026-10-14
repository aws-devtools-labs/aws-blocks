---
"aws-blocks-kotlin": minor
---

Generate the declared type and factory call for a bound transferable result

A direct method result whose transferable tag is bound by `x-blocks-native-bindings` now returns the declared package type and hydrates through its `fromBlocksDescriptor` factory, checked against the declared tag by the new public `validateTransferableDescriptor`. A bound package that declares no `android` field, or whose identity is listed in the new `awsBlocks { excludeNativePackages }` property, keeps the UnknownTransferable fallback, and a declared package that no binding references is reported as `AWSBLOCKS-NATIVE-003`.

**A nullable bound result now returns null for a JSON-null body**, including the four built-in tags. The generated method previously declared the nullable type and called the factory unconditionally, so a null body threw `IllegalArgumentException` from the `jsonObject` cast; a caller that relied on that throw now receives null. A `kotlinPackage` that is not a dotted sequence of Kotlin identifiers, and an `export` that is not an identifier, are now rejected with a spec error instead of generating a client that imports the wrong symbol or does not compile.

`KotlinCodeGenerator` takes a new optional `excludedPackages` parameter, and `RpcModel` and `CodegenModel` carry the new `NativeCatalogs`, so their constructor and `copy` signatures change while staying source-compatible.
