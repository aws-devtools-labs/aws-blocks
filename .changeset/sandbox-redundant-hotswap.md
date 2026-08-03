---
"@aws-blocks/core": patch
---

Remove the redundant `--hotswap` flag from the `cdk watch` invocation in `npm run sandbox`. `cdk watch` already performs hotswap deployments by default, so passing the flag explicitly was redundant and emitted a duplicate-option warning on some `aws-cdk` CLI versions.
