# Resource Ownership & Scoping

**Status:** Proposed — awaiting maintainer review. Breaking change (preview); see [AGENTS.md](../../AGENTS.md) "Stop and ask before any breaking change."

**Scope of this doc:** synth-time resource ownership. Runtime process-globals are explicitly out of scope — see [Non-goals](#non-goals).

---

## Context

An AWS Blocks application is anchored by a **backend root** — a `BlocksStack` (`packages/core/src/cdk/index.ts:68`) or an embedded `BlocksBackend` (`packages/core/src/cdk/blocks-backend.ts:207`). The framework already treats that root as the unit of an application: `Scope.root` resolves to it by walking the construct tree (`cdk/index.ts:244-256`), and `fullId`, `executionRole`, `defaults`, the default compute, and VPC context all derive from it.

But a second, **inconsistent** notion of ownership runs alongside it: a large amount of shared state keys on `cdk.Stack.of(scope)` instead of the backend root, and some keys on nothing at all (a bare process-global). A `BlocksBackend` is a plain `Construct` embedded in a customer's `cdk.Stack`, so **two backends can share one `cdk.Stack`** — and CDK synthesizes **all stacks in one Node process**. Both facts break the state that isn't owned by the backend root.

These bugs are invisible at synth: the app builds clean and fails at deploy or runtime.

### Intended outcome

A `BlocksBackend` becomes a fully self-contained, independent unit. One-backend-per-stack (today's ~99% case), many-backends-per-stack, and many-stacks-per-app all behave identically, because every piece of Blocks state is owned by exactly one backend root.

---

## The two scoping notions today

| Notion | How it's found | What uses it |
|---|---|---|
| **Backend root** (correct) | up-walk the construct tree to the nearest `BlocksStack`/`BlocksBackend` (`cdk/index.ts:244-256`), or `getVpcContext`'s up-walk (`cdk/vpc.ts:50-58`) | `fullId`, `executionRole`, `defaults`, default compute, VPC context |
| **`cdk.Stack`** (wrong) | `cdk.Stack.of(scope)` | config/compute/dashboard/tracer/vpc-requirements registries; config bucket; realtime/cron/GSI/secret/agent shared infra |
| **process-global** (wrong) | `globalThis` key | RawRoute registry; `CURRENT_BLOCKS_STACK`; client-middleware collector |

## The principle

> **Every piece of Blocks state is owned by exactly one backend root, and discovered by walking the construct tree — never via a bare process-global, and never via `cdk.Stack`.**

VPC already embodies this. `getVpcContext(scope)` (`cdk/vpc.ts:50-58`) walks up `node.scope` to find the context set on the owning root, and `getOrCreateVpc` (`cdk/vpc.ts:91-98`) memoizes on the construct it's handed. Nothing else does — this design generalizes VPC's up-walk to all shared state.

`AWS::ApiGateway::Account` is the **one deliberate exception** (`cdk/apigateway-account.ts`): it's a genuine account/region singleton, so it correctly stays stack/account-scoped.

---

## Bug catalog

### Bug class 1 — wrong ownership key (`cdk.Stack`): two backends in one stack collide

When two `BlocksBackend`s share a `cdk.Stack`, every `cdk.Stack.of(scope)`-keyed registry collapses their state into one:

| Resource | Key (file:line) | Failure with two backends in one stack |
|---|---|---|
| Config registry + bucket | `cdk/config-registry.ts:10,48,84` | `finalized` guard (`:127`) makes the **first** backend win; the second backend's config entries are dropped → its BBs read missing config at runtime. |
| Compute registry | `cdk/compute/compute-registry.ts:8,34` | Both backends' computes land in one list; finalize steps (config/tracing) stamp across backends. |
| Dashboard registry | `cdk/dashboard-registry.ts:6,46` | Deferred dashboard bodies mix across backends. |
| Tracer presence | `cdk/tracer-registry.ts:8,20` | A Tracer in backend A flips X-Ray on for backend B's computes. |
| VPC requirements | `cdk/vpc-requirements-registry.ts:8,47` | Backend A's endpoint/egress requirements attributed to B's finalize. |
| Realtime shared infra | `bb-realtime/src/index.cdk.ts:64,189` | Backend B's realtime silently attaches to **A's** WebSocket API. |
| Cron scheduler role | `bb-cron-job/src/index.cdk.ts:74,45` | The shared scheduler role is pinned to the **first** cron's handler ARN; B's cron invokes A's handler. |
| Distributed-table GSI provider | `bb-distributed-table/src/index.cdk.ts:291,244` | One GSI-manager provider shared across backends. |
| App-setting secret bulk-init | `bb-app-setting/src/index.cdk.ts:213,159` | One bulk-init resource batches both backends' secrets. |
| Agent runtime shared grants | `bb-agent/src/agentcore-runtime.cdk.ts:82` | The grants guard fires once per stack, so B's agent **skips its grants entirely** — they were applied to A's role. Least-privilege / correctness defect. |

### Bug class 2 — no ownership key (process-global): leaks across backends *and* stacks

CDK synthesizes all stacks in one process, so an un-owned global is shared by every backend in the whole app:

| Resource | Key (file:line) | Failure |
|---|---|---|
| RawRoute registry | `raw-route.ts:152` (global string) | `Hosting` builds CloudFront behaviors from the **global** `getRegisteredRoutes()` (`hosting.ts:885`) → every stack's distribution picks up every other stack's routes. And `registerRoute`'s method+path dedup is global (`raw-route.ts:261-270`) → two backends each defining `/health` throw `DuplicateRoute` at synth. |
| Config bucket parent | `config-registry.ts:86` reads `globalThis.CURRENT_BLOCKS_STACK` | `ensureConfigBucket` parents the bucket under the *ambient* pointer, not the `root` it's already passed. Concurrent/nested `create()` can parent one backend's bucket under another. |
| Client-middleware collector | `scripts/generate-client.ts:29` | Unconditional `delete` (vs. `generate-spec.ts:258-259`'s guarded delete) can drop a collector a caller owns. |

### Bug class 3 — `fullId` fallback collision

`BlocksBackend.fullId` (`blocks-backend.ts:269-279`) returns `${stackName}-${node.id}`, but when `stackName` is an unresolved token (e.g. a nested stack — Amplify Gen2 `backend.createStack`), it falls back to bare `this.node.id`, dropping the uniqueness qualifier. Two backends whose top-level stack names are tokens can then derive identical `fullId`s → colliding physical names (DynamoDB `tableName`, SQS `queueName`, schedule `name`) in one account/region.

---

## Proposed model

### New primitive — `packages/core/src/cdk/root-registry.ts`

```ts
/** Up-walk to the nearest backend root; fall back to the ambient pointer. */
export function getBlocksRoot(scope: Construct): BlocksStack | BlocksBackend;

/** getOrCreate a Symbol-keyed slot on the backend root. */
export function getOrCreateOnRoot<T>(scope: Construct, key: symbol, factory: (root: Construct) => T): T;
```

- `getBlocksRoot` lifts the exact logic already duplicated in `Scope.resolveRoot` (`cdk/index.ts:244-256`) and the `defaults` getter (`cdk/index.ts:368-374`); refactor both to call it.
- **Avoid an import cycle** (`root-registry` ← `BlocksStack`/`BlocksBackend`): identify the root by a `Symbol.for('blocks:BackendRoot')` brand set on both classes, checked instead of `instanceof`. This matches the existing brand convention (`Symbol.for('blocks:LambdaCompute')` at `bb-lambda-compute/src/index.cdk.ts:30`; `Symbol.for('blocks:ApiNamespace')` at `api.ts:58`) and is resilient to duplicate package copies.

### Pillar A — re-key `cdk.Stack` registries to the backend root

Replace `cdk.Stack.of(scope)` → `getBlocksRoot(scope)` as the registry key in each file from Bug class 1 (core: compute/config/dashboard/tracer/vpc-requirements registries; BBs: realtime/cron/distributed-table/app-setting/agent). Keep `apigateway-account.ts` on `cdk.Stack` (documented exception).

### Pillar B — de-globalize un-owned synth state

- **Config bucket:** in `ensureConfigBucket` (`config-registry.ts:82-98`), parent `BlocksConfigBucket` under `getBlocksRoot(scope)` instead of reading `globalThis.CURRENT_BLOCKS_STACK`. `finalizeConfigRegistry` already receives `root` — thread it through. (For a single-backend `BlocksStack`, root === the ambient pointer, so this is a no-op there.) Leave `CURRENT_BLOCKS_STACK` only as the last-resort `Scope`-parent fallback.
- **RawRoute owner-tagging:** add an optional `ownerRootId?: string` to `RegisteredRoute` (`raw-route.ts:97`). The `RawRoute` CDK construct resolves `getBlocksRoot(this).fullId` and passes it into `registerRoute` (which today takes no scope — `raw-route.ts:241`). Scope the `DuplicateRoute` dedup **per owner** so two backends can each define `/health`. `Hosting` (`hosting.ts:885`) filters `getRegisteredRoutes()` to `getBlocksRoot(hosting).fullId`. The registry stays a process-global (runtime `matchRoute` has no construct tree, and one Lambda serves one backend, so runtime dispatch is unaffected).
- **Client-middleware collector:** make the `delete` at `generate-client.ts:29` conditional (delete only if this call created the collector), matching `generate-spec.ts:258-259`.

### Pillar C — harden the `fullId` token fallback

In `BlocksBackend.fullId` (`blocks-backend.ts:269-279`), when `stackName` is unresolved, disambiguate with a stable unique id (e.g. a `cdk.Names`-derived hashed suffix) rather than bare `node.id`, and emit a synth warning. See [Open decisions](#open-decisions-for-maintainers) #1.

---

## Non-goals

**Runtime / single-process process-globals are out of scope** — verified not reachable by any supported customer path. Every runtime entry loads exactly one backend module per Node process:

- Local dev-server: a single `await import(backendUrl)` of one `backendPath` (`scripts/dev-server.ts:677`); `startDevServer`/`startSandbox` take a scalar `backendPath: string`, and a port singleton guard refuses a second supervisor.
- Sandbox: spawns `cdk watch` + `tsx watch` dev-server as **subprocesses** (separate OS processes, one backend each).
- Deploy: each `BlocksBackend` is its own Lambda function → one backend per process.
- e2e: runs the dev-server as a detached subprocess.

No loop or API mounts two backends into one runtime process. The unkeyed runtime globals are safe regardless: the SDK registry (`common/sdk-registry.ts:24`) and event-handler map (`common/index.ts:208`) are keyed by `fullId`; the RawRoute list throws `DuplicateRoute` on a clash rather than silently cross-wiring; the CORS and S3-config caches aren't used in local dev (`dev-server.ts` uses its own `buildDevCorsHeaders`). A customer could only contrive a collision by hand-authoring an `index.ts` that imports a second app's backend — outside the supported model. Documented as a known limitation.

---

## Back-compat & migration

- **`BlocksStack` apps (`create-app` default, ~99%): byte-identical, no replacement.** The root *is* the stack, so `getBlocksRoot(x) === cdk.Stack.of(x)` and every parenting decision is unchanged.
- **Embedded `BlocksBackend` apps** using realtime / cron / distributed-table / app-setting / agent: those shared resources re-parent from the stack to the backend construct → **resource replacement** on next deploy. Requires a changeset entry + migration note. (The config bucket is already parented under the ambient backend, so no change there.)
- Ship a **changeset** covering `@aws-blocks/core` + every touched BB package.

## Tests

- **core cdk test — two `BlocksBackend`s in one `cdk.Stack`:** assert independent config buckets, execution roles, realtime WebSocket APIs, scheduler roles, and no shared registry entries. (Today's `blocks-stack.test.ts` covers only *separate* stacks.)
- **Hosting test — two `BlocksStack`s, each with `Hosting` + a `RawRoute`:** each CloudFront distribution carries only its own route behaviors (Pillar B).
- **Regression snapshot:** an existing single-`BlocksStack` synth has unchanged logical IDs (proves the 99% no-op).
- **e2e:** add a second namespace/backend to `test-apps/comprehensive/` if it can be wired cast-free.

## Verification

- `npm run build && npm run lint:deps && npm test && npm run test:e2e:local`
- `npm run check:api` (run `npm run update:api` for the new `root-registry` exports).
- `cdk synth --conditions=cdk` on a two-backend fixture; inspect the template for distinct per-backend resources.

## Open decisions for maintainers

1. **`fullId` token fallback:** hash-suffix disambiguation (keeps deploys working, changes physical names for the collision-prone cases) vs. a hard synth error demanding an explicit name. Recommendation: hash-suffix + warning.
2. **`CURRENT_BLOCKS_STACK`:** remove entirely (require explicit `parent`) or keep only as the last-resort fallback. Recommendation: keep as fallback; the up-walk makes it rarely load-bearing.
3. **`__PIPELINE_STAGE_SCOPE__`** (`cdk/index.ts:5,141`) — same ambient-pointer family. Fix alongside `CURRENT_BLOCKS_STACK` or track separately.
4. **Rollout:** land Pillar A + B + C together (one breaking change, one changeset) vs. stage them.
