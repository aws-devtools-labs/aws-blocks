---
'@aws-cdk-blocks/core': minor
'aws-cdk-blocks': minor
'@aws-cdk-blocks/hosting': minor
'@aws-cdk-blocks/create-blocks-app': minor
'@aws-cdk-blocks/admin-ui': minor
'@aws-cdk-blocks/bb-database': minor
---

**Breaking: the hidden `.blocks/` folder is now `.cdk-blocks/`, and local data moves from `.bb-data/` to `.cdk-blocks/local/data/`.**

To upgrade an existing app:

1. Move the config file: `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`. Then delete the empty `.blocks/` folder. Do not run `git mv .blocks .cdk-blocks`, because it nests the old folder inside the new one when `.cdk-blocks/` already exists.
2. In your tsconfig `include`, change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts`. Without this change, `getSecret()` and `getConfig()` lose their key types.
3. Run `npm run typegen` and commit `.cdk-blocks/hosting-values.d.ts`.

Local data, the local database included, is copied to the new location the first time each block opens its store. `.bb-data/` stays in place. `.cdk-blocks/local/` ignores itself, so it needs no `.gitignore` rule.

An app that still has `.blocks/config.json` deploys and destroys as before. The telemetry first-run notice prints once more after the upgrade. Pull request #1607 has the full notes.
