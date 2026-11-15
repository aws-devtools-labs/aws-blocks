---
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

The production settings of `DistributedTable` and `FileBucket` now live in a `PRODUCTION.md` next to each block's `README.md`, which links to it. `DistributedTable`'s covers scaling and cost, durability, deletion protection and encryption. `FileBucket`'s covers access logging, KMS encryption, Object Lock, scaling and cost. Both files ship in their packages and in `@aws-blocks/blocks` under `docs/<block>/`, and the shorter READMEs can be read in one pass.
