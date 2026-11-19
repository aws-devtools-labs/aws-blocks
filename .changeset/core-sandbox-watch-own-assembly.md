---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

fix(core,create-blocks-app): `npm run deploy` works while `npm run sandbox` watches the same app

`npm run deploy` failed every time `npm run sandbox` watch ran in the app, with `Another CLI (PID=…) is currently synthing to cdk.out`: the deploy regenerates `cdk-blocks/client.js`, the sandbox's `cdk watch` saw the change and started a synth, and both used `./cdk.out`. Nothing said that the other CLI was the sandbox.

- The sandbox's `cdk watch` now synthesizes into `.cdk-blocks-sandbox/cdk.out` (`--output`), as its first deploy does, never into the `./cdk.out` of `npm run deploy`.
- The templates' `cdk.json` `watch.exclude` lists `cdk-blocks/client.js`, which the deployed backend doesn't use, so regenerating it starts no watch deploy. Existing apps can add `"cdk-blocks/client.js"` to `watch.exclude` in their `cdk.json`.
- A sandbox deploy or a sandbox destroy (`npm run sandbox:deploy`, a second `npm run sandbox`, `npm run sandbox:destroy`) refuses to start while a `npm run sandbox` of the app is running, before it reaches AWS: `A \`npm run sandbox\` is running in this app (pid …, dev server on :3000), and its cdk watch deploys every change to the sandbox. Stop it first, with Ctrl-C in its terminal or \`npm run dev:stop -- --port 3000\`, then re-run …`. New exports: `assertNoRunningSandbox()` from the sandbox module, and `liveSandboxSession()` from `@aws-blocks/core/scripts/dev-pidfile`.
