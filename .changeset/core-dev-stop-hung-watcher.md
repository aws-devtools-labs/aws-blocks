---
"@aws-blocks/core": patch
---

fix(core): `cdk-blocks dev stop` makes sure the session ended when its runner was killed

When a signal killed the dev server's runner (the OOM killer, a `kill -9`), `tsx watch` waited forever for an exit it had already missed, and ignored SIGTERM. `cdk-blocks dev stop` sent that SIGTERM, saw the port free, reported `Stopped`, and removed the pidfile, while `cdk-blocks dev` and `tsx watch` kept running out of reach of any command, and the frontend the runner had started kept its port.

- `stopDevServer()` now waits for the `tsx watch` it signalled to exit: up to 8 s while the runner is alive, and 2 s when the runner is already dead, after which it SIGKILLs the watcher. It never SIGKILLs a watcher whose runner is still shutting down. A watcher that is still running makes the stop a warning (`portFree: false`), and its record stays.
- A runner that died runs no cleanup, so the stop also stops the frontend group it recorded, as for a stale record.
- `StopResult` gains `killed: true` when the watcher was SIGKILLed, and the message says `its tsx watch had lost its runner and ignored SIGTERM, so it was killed`.
