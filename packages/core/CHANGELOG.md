# @aws-blocks/core

## 0.1.12

### Patch Changes

- 71eb746: Fix eleven reproducible hosting issues:

  - **Astro SSR `/_image` content-type**: the SSR bundle now ships a linux-x64 `sharp` (installed post-build into `dist/server/node_modules`, wasm fallback pruned, ~19.5 MB), so Astro's default `sharp` image service works on Lambda and `/_image` returns a real optimized image with a correct MIME (`image/png`/`image/webp`) instead of the `noop` passthrough's `content-type: image/null`. Gated on the app using the sharp service; apps that pick `noop`/custom are skipped. A dedicated image Lambda isn't feasible for Astro (it fuses `/_image` into the SSR bundle via the `astro:assets` virtual module, unlike Nuxt IPX / OpenNext).

  - **Next image optimizer on Next 15.x**: the `fetchInternalImage` arity patch was gated on an inverted version assumption (the `maximumResponseBody` parameter was added in Next 16, not 15.5). It now only applies on Next ≥ 16, so local image optimization no longer 500s on Next 15.x apps. Renamed `patchImageOptimizerForNext155` → `patchImageOptimizerForNext16`.
  - **Image optimizer on disallowed types (SVG)**: an untrusted SVG (with `dangerouslyAllowSVG` disabled) now fails closed with its real `400` status instead of a blanket `500` — OpenNext was catching Next's 400 in a generic block that discarded the status.
  - **SPA hashed assets**: the SPA adapter now marks Vite's content-hashed `assets/*` bundles `immutable` (`immutablePaths: ['assets/*']`) instead of leaving them in the revalidation-only cache tier.
  - **Missing static assets**: the OAC bucket policy now grants `s3:ListBucket` so a missing key returns a clean `404 NoSuchKey` instead of leaking `403 AccessDenied` XML to the viewer.
  - **RSC prefetch cache efficiency**: the SSR cache policy excludes Next's random `_rsc` prefetch query param from the cache key (`denyList('_rsc')`), so prefetches of the same page share one edge cache entry.
  - **Wildcard redirects**: Next `:path*` named-catch-all redirects are now lifted to the edge router (converted to `/*`), with a bare-prefix companion redirect, so they no longer leak the literal `:path*` token in `Location`.
  - **Route-table budget**: `TooManyRoutesError` now names which table (routes/redirects/headers) exceeded the budget and calls out `trailingSlash: true` as the likely driver, and the previously-hardcoded 64-chunk cap is now tunable via the `quotas.maxRouteChunks` hosting prop (default 64) for very large sites with measured edge-function headroom.
  - **Nuxt ISR/SWR on-demand pages**: when ISR/SWR is active (`manifest.cache` set), route coalescing now folds a prerendered static sibling group into a single `parent/*` **compute** wildcard (instead of a static one), so a non-prebuilt on-demand child renders at the SSR Lambda instead of hard-404ing from S3 — while the route table stays bounded (one row per parent), avoiding the CloudFront-Function compute-limit 503 a non-coalesced fan-out would cause.
  - **CloudFront S3-origin policy**: every behavior whose origin is S3 — the default behavior AND the edge-route (`runtime: 'edge'`) behavior — now uses a synthesized custom origin request policy instead of the managed `ALL_VIEWER_EXCEPT_HOST_HEADER`, which CloudFront rejects on S3 origins (`InvalidRequest` at distribution create). The sentinel behaviors keep the managed policy (their origins are the tagged server/image custom origins, not S3). A regression guard asserts no S3-origin behavior references a managed origin request policy.
  - **Nuxt IPX remote images**: the IPX image Lambda now rides the shared SSR API Gateway (via a dedicated `<baseURL>/{proxy+}` resource) instead of an OAC Function URL, so an unencoded `://` in a remote source path no longer breaks SigV4 (was `403 InvalidSignatureException`); and the IPX runtime is configured with `httpStorage` scoped to the allowlisted domains so allowlisted remote images resolve instead of `404 IPX_RESOURCE_NOT_FOUND`.

- Updated dependencies [71eb746]
- Updated dependencies [71eb746]
  - @aws-blocks/hosting@0.1.5

## 0.1.11

### Patch Changes

- 76e1e50: fix(core): robust dev server — startup port reclaim, singleton guard, and :3000 EADDRINUSE handling

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

## 0.1.10

### Patch Changes

- e839301: fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

  The external-database connection string was stored in an SSM parameter named only
  by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
  the same AWS account + region + stage computed the same name and silently
  overwrote each other's credentials.

  The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
  single new `getStackName({ sandbox, projectRoot })` helper that is also the one
  place the CDK templates compute the stack name (replacing logic duplicated across
  templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
  from `getStackName({ sandbox, projectRoot })` — is used
  by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
  synth, so the written name and the read name are derived once, from committed
  config (`.blocks/config.json`) — never from the connection string — and cannot
  diverge. The name is computable before synth (enabled by the committed stackId from
  PR #51), so no post-deploy write-back or staging-copy machinery is needed.

  The previous stage-only parameter is orphaned and self-heals on the next deploy.

## 0.1.9

### Patch Changes

- 9075b81: Fix four hosting correctness bugs:

  - **Base path is now a first-class `Hosting` prop, and Nuxt `app.baseURL` is modelled.** Added a caller-declared `basePath` option to `Hosting` (e.g. `{ basePath: '/app' }`) — the recommended, framework-agnostic source of truth that CloudFront behaviors are prefixed with (plus a root→`/<basePath>/` 308 redirect). When the prop is omitted, the Nitro adapter now detects Nuxt's `app.baseURL` from the build output and sets `manifest.basePath` (parity with Next `basePath` / Astro `base`); previously it was silently dropped, so a Nuxt app with a base path deployed broken — pages rendered but their hashed `/<base>/_nuxt/*` assets 404'd (no hydration). If a base path is detected in the prerendered output but can't be read, synth fails loud instead of shipping a broken site.
  - **Per-pattern header rules delegate to the SSR runtime instead of competing for CloudFront behavior slots.** For SSR (compute) deploys, a header rule whose pattern has no dedicated behavior is no longer wired as its own CloudFront behavior — the request falls through to the catch-all SSR Lambda, which already emits the framework's `headers()` / `routeRules` at runtime (CloudFront caches the response including those headers). This removes redundant behaviors that burned the scarce ~25-behavior budget and re-asserted a header the origin already sets, and it means SSR header rules can never trip the behavior cap. For **static-only** deploys (S3 origin, no runtime to emit the header) the cap still applies: a rule that would exceed it throws if it sets a security header (CSP, HSTS, X-Frame-Options, … — a lost CSP otherwise looks like a successful deploy) and is dropped with a warning if it's cosmetic.
  - **config.json deploy ordering is now wired correctly.** The resolved `config.json` deployment now depends on the asset deployments so the build's placeholder config can't clobber it. The previous `tryFindChild('AssetDeployment')` never matched the real child ids and the dependency was silently never created.
  - **AWS service quotas are now centrally accounted, configurable, and degrade gracefully.** A new `QuotaBudget` module centralizes the previously-scattered, hardcoded limits (CloudFront cache behaviors, Lambda@Edge associations, and the account-wide response-headers-policy quota — the last of which was previously unguarded and blew up opaquely at deploy time). Three things change:
    - **Configurable:** a new `quotas` prop on `Hosting` (`{ cacheBehaviors?, edgeFunctions?, headerPolicies? }`) lets accounts that have been granted a Service Quota increase raise the corresponding ceiling, instead of hitting a hardcoded throw at the AWS default. Each field documents that synth cannot verify the real granted quota, so an over-set value just moves the failure to deploy time.
    - **Graceful degradation (SSR):** when prerendered pages would exceed the behavior budget on a compute deploy, the lowest-priority pages are demoted to the SSR runtime (served by the catch-all Lambda) instead of failing the build — deterministically, and never touching hashed-asset prefixes, edge routes, image-opt, or non-default compute origins.
    - **Grouping (static-only):** when co-located sibling pages would exceed the budget on a static deploy (no runtime to demote to), they collapse into one `<parent>/*` behavior — lossless, since every path under the parent resolves from S3 either way.
    - **Deploy-fail guards for hard limits:** the static-asset upload Lambda (CDK's `BucketDeployment`) is now sized to 1024 MB / 1024 MiB `/tmp` (up from CDK's 128 MB / 512 MiB defaults, which large sites silently overran with an opaque CloudFormation failure), overridable via `storage.deployment`. Synth also now emits a warning as a stack approaches CloudFormation's hard 500-resource-per-stack limit, so the operator can split the stack before a deploy fails opaquely.

- Updated dependencies [9075b81]
  - @aws-blocks/hosting@0.1.4

## 0.1.8

### Patch Changes

- e9dc073: fix(telemetry): send events via detached subprocess to prevent dropped events

  Telemetry events are now sent via a detached background subprocess instead of
  an in-process https.request. This ensures events are delivered even when the
  parent CLI process exits on failure paths before the socket flushes.

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
