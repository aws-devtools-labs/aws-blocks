---
"@aws-blocks/blocks": minor
---

feat(blocks): add the `blocks` CLI

`@aws-blocks/blocks` now installs a `blocks` command (also available as `cdk-blocks`) for the whole app lifecycle: `blocks dev`, `blocks sandbox`, `blocks deploy`, `blocks destroy`, `blocks whoami`, `blocks secret`, `blocks config`, `blocks telemetry`, `blocks generate client|spec|types`, `blocks db` and `blocks vendorize`. Each lifecycle command runs the same code as the matching npm script of a generated app, so `npx --no -- blocks dev` behaves like `npm run dev`, and the npm-script spellings (`dev:stop`, `sandbox:destroy`, `typegen`, …) work as aliases. Run it as `npx --no -- blocks <command>`: `--no` uses the installed CLI and never downloads a package, while a bare `npx blocks` would install the unrelated `blocks` package from npm.

The CLI prints results on stdout and progress on stderr, supports `--output json` and `--query <field>` (for example `API_URL=$(npx --no -- blocks deploy --query apiUrl)`), and exits 0 on success, 1 on failure, 2 on a usage error and 130 when interrupted. `blocks destroy` shows the stack it deletes and asks first; in a non-interactive run it requires `--yes`. Local server settings can be set in `package.json` under `"blocks": { "dev": { … } }`; without a `frontendCommand` the frontend is detected from `vite` or `next` and started on `frontendPort` (default 3100). `@aws-blocks/blocks` now depends on `tsx`; the CLI uses the app's own `tsx` first, else that one, for its lifecycle runners and for client generation. `blocks-generate-client` falls back to it the same way, so it no longer needs the app to install `tsx`. CDK synth still runs the app's own `tsx` (the `app` command in `cdk.json`, or `npm exec tsx` for the sandbox commands), so apps keep `tsx` as a devDependency, as the templates do.

`@aws-blocks/blocks/scripts` re-exports `@aws-blocks/core/scripts`, so the lifecycle scripts it exports now honor `BLOCKS_LOG_LEVEL` and `BLOCKS_LOG_STREAM`, and it exports `readAwsIdentity()`, `describeDeploymentCredentials()`, `resolveDeploymentTarget()` and `log`.
