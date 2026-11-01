---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core,blocks): one `blocks dev` per app, whatever its port

A second `blocks dev` of the same app on another port (`blocks dev --port 42412` while one runs on 42411) used to start. Both opened the app's `.bb-data`: the second PGlite removed the first one's live `postmaster.pid`, both ran PostgreSQL on one data directory, and the writes acknowledged by one of them were lost on the next start. A dev server in `blocks sandbox` and a `blocks dev` of the same app split their configs the same way.

- A dev server, or a `blocks dev` claiming its session, that finds a live dev-server pidfile of the app on another port now refuses to start, removes the record it wrote, and exits 1 with `a dev server of this app is already running on :<port> (pid <pid>)`. The pidfiles stay per port, with the same exclusive claim; each start writes its record before it reads the others', so of two starts on two ports at the same moment at least one refuses.
- The hint names the running server's port, `npx --no -- blocks dev stop --port <port>`, and no longer suggests another `--port`, which would not help.
- `claimDevPidfile()` and `claimDevSession()` return that port as `port` when they refuse. New export from the dev-server module: `devStopCommand(port)`.
