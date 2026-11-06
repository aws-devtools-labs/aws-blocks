---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core,blocks): one `cdk-blocks dev` per app, whatever its port

A second `cdk-blocks dev` of the same app on another port (`cdk-blocks dev --port 42412` while one runs on 42411) used to start. Both opened the app's `.bb-data`: the second PGlite removed the first one's live `postmaster.pid`, both ran PostgreSQL on one data directory, and the writes acknowledged by one of them were lost on the next start. A dev server in `cdk-blocks sandbox` and a `cdk-blocks dev` of the same app split their configs the same way.

- A dev server, or a `cdk-blocks dev` claiming its session, that finds a live dev-server pidfile of the app on another port now refuses to start, removes the record it wrote, and exits 1 with `a dev server of this app is already running on :<port> (pid <pid>)`. The pidfiles stay per port, with the same exclusive claim; each start writes its record before it reads the others', so of two starts on two ports at the same moment at least one refuses.
- The hint names the running server's port, `npx --no -- cdk-blocks dev stop --port <port>`, and no longer suggests another `--port`, which would not help.
- `claimDevPidfile()` and `claimDevSession()` return that port as `port` when they refuse. New export from the dev-server module: `devStopCommand(port)`.
- `cdk-blocks sandbox`, when it will start a dev server (neither `sandbox deploy` nor `sandbox preview`), refuses before the synth and the deploy while a dev session of the app runs or is starting on any port, with `A dev server of this app is already <running|starting> on :<port> (pid <pid>)` and the `dev stop --port` command. Before, it deployed, then its dev server was refused and the sandbox ended. New exports: `liveDevSession()` from `@aws-blocks/core/scripts/dev-pidfile`, and `assertNoRunningDevServer()` from the sandbox module.
