---
"@aws-blocks/create-block": patch
---

chore(create-block): add the `aws-blocks` keyword for npm discoverability

`@aws-blocks/create-block` was published without a `keywords` array, so it did
not appear in `npm search keywords:aws-blocks`, the discovery path the
publishing guide documents (#491). This adds the `aws-blocks` keyword, which
also satisfies the `keywords-guard.ts verify-discovery-tag` CI check that was
failing on every PR because of this gap.
