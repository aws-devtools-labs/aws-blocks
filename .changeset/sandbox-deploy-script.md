---
"@aws-blocks/create-blocks-app": patch
---

feat(create-blocks-app): add a one-shot `npm run sandbox:deploy` script to every deployable template

`npm run sandbox` deploys and then keeps running (CDK watch plus the local dev server), so it never exits and can't be used from scripts or CI. The new `npm run sandbox:deploy` runs the same sandbox script with `--deploy-only`: it deploys once, writes `.blocks-sandbox/config.json` and the generated client, prints the `BLOCKS_DEPLOYED` line, and exits. `npm run sandbox` is unchanged. The template READMEs and the scaffolded `AGENTS.md` list the new script.
