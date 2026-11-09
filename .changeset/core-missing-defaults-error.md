---
"@aws-blocks/core": patch
---

`BlocksStack.create()` and `BlocksBackend.create()` without a `defaults` field now fail with an error that names the fix (`defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`, with its import) and links a new guide for apps scaffolded from older `create-blocks-app` templates. Before, they threw `TypeError: Cannot read properties of undefined (reading 'vpc')`, because `cdk` runs `aws-blocks/index.cdk.ts` without type-checking. The guide, `docs/guides/upgrading-older-apps.md`, shows the `index.cdk.ts` edits for templates 0.1.0 to 0.1.19 (add `defaults`, drop the hand-written sandbox overrides) and 0.1.20 to 0.2.0 (remove `blocksStack.handler`).
