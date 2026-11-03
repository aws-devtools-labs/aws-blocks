---
"@aws-blocks/core": patch
---

fix(core): `cdk-blocks sandbox` ends with its dev server, and `cdk-blocks dev stop` says it stopped the sandbox

`cdk-blocks dev stop` (and `dev stop --all`) stopped the dev server of a running `cdk-blocks sandbox`, reported `Stopped the dev server`, and removed its pidfile, while `cdk-blocks sandbox` and its `cdk watch` kept running, hotswapping every save into the sandbox stack, out of reach of any command.

- `startSandbox()` now stops the session (its `cdk watch` included) when its dev server exits: exit code 0 when the dev server was stopped, 1 with `The local dev server exited (code N); stopping the sandbox session.` when it failed.
- The sandbox passes its pid to the dev server in `BLOCKS_SANDBOX_SESSION`, which records it in its pidfile record as `sandbox: { pid }` and keeps it out of the frontend's environment. `stopDevServer()` then waits for that session to end, returns it as `StopResult.sandbox`, and reports `Stopped the cdk-blocks sandbox session on :3000 …: its dev server and its cdk watch. Its AWS resources are still deployed; \`npx --no -- cdk-blocks sandbox destroy\` deletes them.`, or a warning when the session has not ended.
- New exports: `SANDBOX_SESSION_ENV` from `@aws-blocks/core/scripts/dev-pidfile`, and `sandboxDevServerExitCode()` from the sandbox module.
