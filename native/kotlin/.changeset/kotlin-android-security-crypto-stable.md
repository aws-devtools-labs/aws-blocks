---
"aws-blocks-kotlin": patch
---

Pin `androidx.security:security-crypto` to the stable `1.1.0` release

The Android credential store now depends on the stable `1.1.0` release of `androidx.security:security-crypto` instead of the `1.1.0-alpha06` pre-release. The store keeps the same key and value encryption schemes, so values written by earlier versions remain readable after upgrading.
