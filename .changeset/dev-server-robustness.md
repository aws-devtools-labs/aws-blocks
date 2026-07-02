---
"@aws-blocks/core": patch
---

fix(core): robust dev server — startup port reclaim, singleton guard, and :3000 EADDRINUSE handling

Hardens the local dev server against the port-contention failure modes that
survived PR #80 (which fixed only single-supervisor frontend self-restart):

- **Startup reclaim** — a fresh `server.ts` now frees a stale `:3000`/`:3100`
  listener left by a crashed or `SIGKILL`'d predecessor before it binds the
  front door / spawns the `--strictPort` frontend, instead of relying on the
  previous process's `cleanup()` finishing within tsx-watch's ~5s window.
- **Singleton guard** — a per-port pidfile stops a second `npm run dev` from
  spawning a competing supervisor that fights the first over `:3000`/`:3100`; it
  exits cleanly with a clear message. A stable-parent (`tsx watch`) carve-out
  keeps hot reload working, and a dead-owner pidfile never blocks startup.
- **`:3000` EADDRINUSE robustness** — the backend front door now emits a real
  console error (not only telemetry), reclaims the stale owner and retries the
  bind (bounded), and exits non-zero with a clear message on unrecoverable
  failure, so a contended `:3000` never silently fails to serve.

Reuses the existing `waitForPortFree` / process-group-kill primitives (plus an
`lsof`/`netstat` listener probe mirroring the `cleanup` script) — no new
teardown mechanism. `--strictPort` is retained for local dev, made safe by the
startup reclaim guaranteeing `:3100` is free first.
