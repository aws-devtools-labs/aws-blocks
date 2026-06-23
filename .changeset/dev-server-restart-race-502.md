---
"@aws-blocks/core": patch
---

fix(dev-server): auto-respawn frontend and kill the whole process group on restart

The dev server spawns the frontend (Vite) with `shell: true`, making the real
Vite process a **grandchild** (shell → npx → node vite). On a `tsx watch`
restart, cleanup sent `SIGTERM` to only the shell parent, orphaning the Vite
grandchild — it survived still bound to `:3100`. The freshly launched Vite then
hit `--strictPort`, failed to bind, and exited; the `exit` handler only logged,
so `/` served a permanent `502 Frontend server unavailable` with no recovery.

Fixes:

- **Process-group kill** — the frontend is spawned `detached` on POSIX (its own
  process group) and cleanup/restart now signal the entire group via
  `process.kill(-pid, …)`, reaping the Vite grandchild and freeing `:3100`.
  Windows (no POSIX groups) falls back to a direct child kill.
- **Bounded auto-respawn** — an unexpected frontend exit now respawns Vite with
  exponential backoff, capped at 5 restarts / 10s to avoid hot loops, and is
  suppressed during intentional shutdown via an `isShuttingDown` guard.
- **Robust shutdown** — cleanup is idempotent, wired to `SIGINT`/`SIGTERM`/
  `SIGHUP`, removes its own listeners, waits (bounded) for the group to die
  before exiting (SIGTERM→SIGKILL escalation), and keeps a synchronous
  `process.on('exit')` safety net so a detached Vite is never left orphaned.

`--strictPort` is intentionally retained: the proxy target is hardcoded to
`:3100`, so the port is reliably freed rather than letting Vite drift to another
port the proxy wouldn't follow.
