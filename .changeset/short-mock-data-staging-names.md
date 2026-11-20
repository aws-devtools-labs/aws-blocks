---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

Fix migration of existing local Building Block data with long filenames. The migration uses a short temporary name and still leaves files already present at the destination untouched.
