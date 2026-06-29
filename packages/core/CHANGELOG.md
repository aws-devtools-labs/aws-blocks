# @aws-blocks/core

## 0.1.7

### Patch Changes

- 6eb731a: fix(dev-server): auto-respawn frontend and kill the whole process group on restart

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
    budget counts only _consecutive failing_ restarts: it resets only when **our
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
    escalation, then a port-free poll that runs on _both_ the live and the
    already-exited paths (the post-exit path previously skipped it, so a relaunch
    could race the kernel's socket teardown into `--strictPort` `EADDRINUSE`). A
    synchronous `process.on('exit')` safety net remains for paths that bypass
    cleanup — now routed through the shared tree-kill so it reaps on Windows
    (`taskkill`) too instead of early-returning and leaking the Vite tree.
  - **Consistent post-exit reaping** — the failure being fixed is the _shell
    exiting while the detached grandchild survives_, so every post-exit path
    (the respawn handler, graceful shutdown, and the `exit` safety net) now
    issues one best-effort process-group kill even after the shell has gone,
    rather than skipping it. A surviving grandchild keeps the group's id reserved
    on POSIX, so `process.kill(-pid)` still targets our own group; the kills are
    issued synchronously on observing the exit to keep the PID-reuse window
    minimal. The single rationale lives next to the supervisor as the
    "POST-EXIT GROUP-KILL POLICY" so all three sites stay in agreement.
  - **Sandbox entrypoint parity** — `sandbox.ts` (the sibling dev entrypoint) now
    spawns **both** long-running children — the dev server _and_ `cdk watch` — in
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

- a40e840: fix: bind dev server to all interfaces (0.0.0.0) for WSL2 compatibility

## 0.1.6

### Patch Changes

- f42c604: fix: generate unique stackId in .blocks/config.json, export getStackId/getSandboxId from @aws-blocks/blocks/scripts

  Stack names are now derived from a `stackId` in `.blocks/config.json`, generated at scaffold time as `<name>.slice(0,16)-<random6>`. Templates import `getStackId()` and `getSandboxId()` from `@aws-blocks/blocks/scripts` — no more inline filesystem logic in `index.cdk.ts`.

  Production: `<stackId>-prod`
  Sandbox: `<stackId>-<username(8)>-<random(6)>` (per-machine, gitignored)

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

## 0.1.5

### Patch Changes

- 162c47d: fix(hosting): stop hardcoding image-optimization Lambda reserved concurrency

  The image-optimization Lambda hardcoded `reservedConcurrency: 10`, which made `cdk deploy` fail on fresh AWS accounts (the default account-level unreserved-concurrency limit is also 10, so reserving all 10 drops the account below its required minimum and Lambda returns a 400). It now defaults to no reservation and exposes `compute.imageOptimization.reservedConcurrency` so operators with headroom can still cap it.

- Updated dependencies [162c47d]
  - @aws-blocks/hosting@0.1.3

## 0.1.4

### Patch Changes

- a306ff1: Serve `/.blocks-sandbox/config.json` from the dev server itself instead of proxying it to the framework dev server.

  The browser auth client resolves its API URL by fetching `/.blocks-sandbox/config.json`. The dev server proxied that request to the framework dev server (Next.js/Nuxt/Astro), which only serves its own static dir and returned 404 — so the client failed with "Blocks API URL not configured" in local `dev`. The dev server now answers this reserved path directly, mirroring production where CloudFront serves `/.blocks-sandbox/*` as static assets. Framework-agnostic and requires no per-app workaround.

## 0.1.3

### Patch Changes

- e98bab4: feat(pipeline): extract Pipeline construct into @aws-blocks/pipeline package, add partialBuildSpec for CodeBuild runtime control

  `@aws-blocks/core` receives a minor bump (not patch): it gains a new runtime dependency on `@aws-blocks/pipeline` and adds new public re-exports from its CDK entrypoint (`__PIPELINE_STAGE_SCOPE__`, `Pipeline`, `DeployStage`, and the pipeline configuration types). New backwards-compatible public surface is a minor change per semver.

- Updated dependencies [e98bab4]
  - @aws-blocks/pipeline@0.1.1

## 0.1.2

### Patch Changes

- 18880ff: Fix `deploy`, `sandbox`, and `destroy` failing on Windows: spawn `npm`/`npx`/`cdk` via `cross-spawn` (resolves the `.cmd` shims) and import the backend through a `file://` URL so absolute paths like `D:\...` work during CDK synth.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/hosting@0.1.1

## 0.1.0

Initial version
