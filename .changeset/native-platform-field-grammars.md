---
'@aws-blocks/core': patch
---

Spec generation now rejects a malformed Swift or Android native package field, naming the block that declared it, as it already did for the Dart fields. A `swift.module`, `android.group`, `android.artifact`, or `android.kotlinPackage` outside its own package manager's grammar previously passed validation and was written into `x-blocks-native-packages`. A malformed `module` or `kotlinPackage` then failed in the customer's own codegen run, naming no block; no generator validates `group` or `artifact`, so a malformed value in them went undetected. `swift.identity` and `swift.product` stay non-blank only: SwiftPM derives an identity from the dependency's location and imposes no grammar on either.
