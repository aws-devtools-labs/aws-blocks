---
"@aws-blocks/create-blocks-app": minor
"@aws-blocks/blocks": patch
---

feat(create-blocks-app): add a one-shot `npm run sandbox:deploy` script to every deployable template

`npm run sandbox` deploys and then keeps running (CDK watch plus the local dev server), so it never exits and can't be used from scripts or CI. The new `npm run sandbox:deploy` runs the same sandbox script with `--deploy-only`: it deploys once, writes `.blocks-sandbox/config.json`, prints the `BLOCKS_DEPLOYED api=…` line, generates the typed client, and exits. Wait for exit code 0 rather than for the line, since the client is generated after it. `npm run sandbox` is unchanged. The template READMEs and the scaffolded `AGENTS.md` list the new script.

Existing apps can adopt it by adding `deployOnly: process.argv.includes('--deploy-only')` to the `startSandbox({ ... })` call in `aws-blocks/scripts/sandbox.ts`, and a `"sandbox:deploy": "tsx aws-blocks/scripts/sandbox.ts --deploy-only"` script to `package.json`.
