---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

The production settings of `FileBucket` now live in a `PRODUCTION.md` next to the block's `README.md`, which links to it. It covers access logging, KMS encryption, Object Lock, scaling and cost. The file ships in its package and in `@aws-blocks/blocks` under `docs/<block>/`, and the shorter README can be read in one pass.
