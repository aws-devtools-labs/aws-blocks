---
"@aws-blocks/core": patch
---

Fix the local dev server corrupting multi-byte UTF-8 characters in large RPC and RawRoute request bodies when a character spanned two request chunks.
