---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

Test temp directories are created with `mkdtempSync`, so two tests that start in the same millisecond no longer share a path.
