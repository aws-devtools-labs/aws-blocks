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
  budget counts only *consecutive failing* restarts: it resets only when **our
  own** freshly spawned child is the process now bound to the port. A liveness
  probe alone cannot tell our Vite from a foreign listener (a leftover Vite or a
  second dev server), and crediting a foreign one would make every
  `--strictPort`-failing respawn look successful, neutralizing the cap and
  hot-looping forever. A frontend that legitimately restarts many times (e.g.
  editor-triggered full reloads) is still never permanently left down. Before
  each relaunch the supervisor now also waits (bounded) for `:3100` to be
  released — the same port-free drain the graceful shutdown path uses — so a slow
  socket teardown can't hand the relaunched `--strictPort` Vite an `EADDRINUSE`
  and burn a restart-budget slot; that wait re-checks the `isShuttingDown` guard,
  so a shutdown arriving mid-wait still cancels the relaunch (and the budget is
  debited once, at exit time, so the wait never double-counts a restart).
- **Robust shutdown** — cleanup is idempotent, wired to `SIGINT`/`SIGTERM`/
  `SIGHUP`, removes its own listeners, and waits (bounded) for the group to die
  **and for `:3100` to actually be released** before exiting: SIGTERM→SIGKILL
  escalation, then a port-free poll that runs on *both* the live and the
  already-exited paths (the post-exit path previously skipped it, so a relaunch
  could race the kernel's socket teardown into `--strictPort` `EADDRINUSE`). A
  synchronous `process.on('exit')` safety net remains for paths that bypass
  cleanup — now routed through the shared tree-kill so it reaps on Windows
  (`taskkill`) too instead of early-returning and leaking the Vite tree.
- **Consistent post-exit reaping** — the failure being fixed is the *shell
  exiting while the detached grandchild survives*, so every post-exit path
  (the respawn handler, graceful shutdown, and the `exit` safety net) now
  issues one best-effort process-group kill even after the shell has gone,
  rather than skipping it. A surviving grandchild keeps the group's id reserved
  on POSIX, so `process.kill(-pid)` still targets our own group; the kills are
  issued synchronously on observing the exit to keep the PID-reuse window
  minimal. The single rationale lives next to the supervisor as the
  "POST-EXIT GROUP-KILL POLICY" so all three sites stay in agreement.
- **Sandbox entrypoint parity** — `sandbox.ts` (the sibling dev entrypoint) now
  spawns **both** long-running children — the dev server *and* `cdk watch` — in
  their own process groups and `await`s a bounded group teardown for each
  (run concurrently) on `SIGINT`/`SIGTERM`, replacing the synchronous
  `cdkWatch.kill()` + single dev-server `kill()` + `process.exit(0)` that
  signalled only the npx/shell parents and exited immediately. A bare
  `cdkWatch.kill()` could orphan the real `cdk watch` node process
  (npx → cdk → node) — the same shell-only-kill leak this PR fixes for the dev
  server — so it now routes through the shared `terminateProcessTree` too. Only
  the dev-server drain (the longer 6s budget) owns the `:3100` port-free wait, via
  its own SIGTERM handler, so the next `npm run sandbox` no longer races a
  survivor on `:3100`.
- **Single tree-kill primitive** — the POSIX group-kill, the Windows `taskkill`
  tree-kill, and the bounded SIGTERM→SIGKILL teardown now live in one shared
  `process-tree.ts` module used by every entrypoint (dev server, respawn
  handler, `exit` net, and sandbox), so the reaping behavior can no longer drift
  between hand-rolled copies. Its bounded teardown documents that its boolean
  reflects only the **direct child's** exit (not whole-group teardown or port
  release — callers needing a freed port must follow with `waitForPortFree`), and
  its post-SIGKILL grace is a named `KILL_GRACE_MS` constant kept deliberately
  shorter than the injectable SIGTERM grace (SIGKILL is uncatchable, so only a
  brief beat is needed to observe the exit).

`--strictPort` is intentionally retained: the proxy target is hardcoded to
`:3100`, so the port is reliably freed rather than letting Vite drift to another
port the proxy wouldn't follow.
