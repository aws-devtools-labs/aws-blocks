---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/core": patch
---

fix: generate unique stackId in .blocks/config.json, export getStackId/getSandboxId from @aws-blocks/blocks/scripts

Stack names are now derived from a `stackId` in `.blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts` — no more inline filesystem logic in `index.cdk.ts`.

Production: `<stackId>-prod`
Sandbox: `<stackId>-<username(8)>-<random(6)>` (per-machine, gitignored)
