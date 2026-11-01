---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core,blocks): `blocks dev stop` stops a `blocks dev` that is still starting

The dev server wrote its pidfile only once it had loaded, about a second after `blocks dev` started. A `blocks dev stop` in that time reported `nothing to stop`, and the server then came up and kept running.

- `blocks dev` now claims the session in the pidfile before it starts `tsx watch`, with the same exclusive claim as the dev server, and the dev server it starts takes the record over. A `blocks dev stop` during startup SIGTERMs the CLI, which stops what it started, and reports `via: "cli"`. `blocks dev` exits 0, and nothing is left running.
- A second `blocks dev` on the port is refused at once, before it starts anything.
- When a SIGTERM ends `tsx watch`'s runner before the runner handles signals, `tsx watch` never exits on its own SIGTERM. The CLI now SIGKILLs it once its runner is gone.
- New export `@aws-blocks/core/scripts/dev-pidfile`: the pidfile protocol (`claimDevSession`, `claimDevPidfile`, `releaseDevPidfile`, `DEV_SESSION_ENV`, …), which loads without the rest of core. `claimDevPidfile` takes the pid of the CLI whose record it may take over as an optional last argument, and `StopResult.via` can be `cli`.
