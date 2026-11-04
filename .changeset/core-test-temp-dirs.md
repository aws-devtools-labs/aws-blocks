---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Test temp directories are created with `mkdtempSync`, so two tests that start in the same millisecond no longer share a path.
