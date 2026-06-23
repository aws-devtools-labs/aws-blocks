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
  Windows (no POSIX groups) reaps the tree with `taskkill /T /F /PID <pid>`,
  which walks the child tree by PID so the Vite grandchild is killed too; it
  degrades to a direct child kill only if `taskkill` cannot be spawned.
- **Bounded auto-respawn** — an unexpected frontend exit now respawns Vite with
  exponential backoff, capped at 5 restarts / 10s to avoid hot loops, and is
  suppressed during intentional shutdown via an `isShuttingDown` guard. The
  budget counts only *consecutive failing* restarts: it resets once a respawn
  rebinds the port, so a frontend that legitimately restarts many times (e.g.
  editor-triggered full reloads) is never permanently left down.
- **Robust shutdown** — cleanup is idempotent, wired to `SIGINT`/`SIGTERM`/
  `SIGHUP`, removes its own listeners, waits (bounded) for the group to die
  before exiting (SIGTERM→SIGKILL escalation), and keeps a synchronous
  `process.on('exit')` safety net so a detached Vite is never left orphaned.
- **Consistent post-exit reaping** — the failure being fixed is the *shell
  exiting while the detached grandchild survives*, so every post-exit path
  (the respawn handler, graceful shutdown, and the `exit` safety net) now
  issues one best-effort process-group kill even after the shell has gone,
  rather than skipping it. A surviving grandchild keeps the group's id reserved
  on POSIX, so `process.kill(-pid)` still targets our own group; the kills are
  issued synchronously on observing the exit to keep the PID-reuse window
  minimal. The single rationale lives next to the supervisor as the
  "POST-EXIT GROUP-KILL POLICY" so all three sites stay in agreement.

`--strictPort` is intentionally retained: the proxy target is hardcoded to
`:3100`, so the port is reliably freed rather than letting Vite drift to another
port the proxy wouldn't follow.
