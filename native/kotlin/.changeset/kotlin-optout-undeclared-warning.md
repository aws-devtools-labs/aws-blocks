---
"aws-blocks-kotlin": patch
---

Warn when `excludeNativePackages` names a package the spec does not declare. A misspelled
identity previously opted nothing out in silence, indistinguishable from a working opt-out;
codegen now reports `AWSBLOCKS-NATIVE-006` for it and still generates.
