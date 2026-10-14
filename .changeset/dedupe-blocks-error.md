---
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/blocks": patch
---

refactor: dedupe per-package local blocksError() helpers toward core's exported one

Each Building Block carried its own private `blocksError(name, message)` helper
that minted a named, wire-safe error. Now that core exports a canonical
`blocksError` (prefixing `${name}: ${message}`, setting `.name`, and stamping
the cross-copy `BLOCKS_ERROR_BRAND` via `brandBlocksError`), those copies are
redundant.

Where a copy was byte-identical to core's prefixing helper, it is replaced by a
direct import of core's `blocksError` (bb-app-setting, bb-dashboard,
bb-email-client, bb-file-bucket, bb-kv-store, bb-metrics). Where the package
exposes a typed error name, a thin wrapper is kept and its body delegated to
core so the typed signature is preserved while the minting lives in one place
(`bb-knowledge-base`'s `KnowledgeBaseErrorName`-typed `blocksError`, and
`bb-distributed-table`'s shared internal `blocksError`).

The errors produced are byte-for-byte identical — same `${name}: ${message}`
prefix, same `.name`, same brand — so there is no observable change on the wire
or in a catch block. Two deliberately divergent copies are intentionally left
in place: `bb-app-setting`'s `validation.ts` and `bb-auth-oidc`'s client engine
mint UNPREFIXED errors (`new Error(message)`) to preserve their existing CDK
synth / client error text, which routing through core's prefixing helper would
change.
