# Hosting Preview Mode — deploy-acceleration design

> Status: **design / RFC** · Package: `@aws-blocks/hosting` · Branch: `feat/hosting-preview-mode`
>
> Goal: make hosting deploys fast enough for **ephemeral, throwaway environments** (PR previews, per-branch sandboxes) by shrinking *what* we provision and *how* we provision it, without touching the production deploy path.

## 1. Problem

A first hosting deploy is slow (many minutes) and this is inherent to what it stands up: a global CloudFront distribution, sometimes Lambda@Edge, sometimes an ACM cert. That cost is justified for production but is pure friction for a PR preview whose entire lifetime is "spin up, click around, tear down." We want a **preview mode** that trades production-grade edge features for speed.

Two levers are available and they are **orthogonal** — a good preview uses both:

| Lever | Question it answers | Owner |
|---|---|---|
| **Deploy mechanism** | How does CloudFormation apply the change? | `@aws-blocks/core` sandbox CLI (already in flight — see §2) |
| **Resource shape** | *What* resources does hosting even create? | `@aws-blocks/hosting` (this doc) |

## 2. Prior art already in the repo (don't duplicate)

The `worktree-sandbox-express-mode` branch already adds the **deploy-mechanism** lever in `packages/core/src/scripts/sandbox.ts`:

- `cdk deploy --method direct` — skip CloudFormation change-set creation; call `UpdateStack` directly.
- `cdk deploy --express` — **CloudFormation Express Mode**: report each op complete as soon as config is applied, *without* waiting for full stabilization (and, as a side effect, no automatic rollback — acceptable for throwaway stacks only).
- Sandbox deploys already pass **`--context sandboxMode=true`**, and app `index.cdk.ts` files already read `app.node.tryGetContext('sandboxMode') === 'true'` to pick a per-sandbox stack name.

So the mechanism is being handled at the CLI layer. **Preview mode is the resource-shape half**, and `sandboxMode` is the context flag it can key off. The two compose: Express Mode makes each op finish sooner; preview mode reduces the number and slowness of the ops in the first place.

## 3. Where hosting deploy time actually goes

From the CDK map of `packages/hosting/src/constructs/*` (resource → file:line, ranked by typical wall-clock cost):

1. **ACM `DnsValidatedCertificate`** — `dns_construct.ts:120`. DNS validation takes minutes; a misconfigured cert can hang CloudFormation for up to 72h. **Only** created with `domain` + hosted zone. *Avoidable in preview.*
2. **CloudFront `Distribution` create/update** — `cdn_construct.ts:1115`. Global propagation; the dominant cost on nearly every deploy. Currently **unconditional**.
3. **Lambda@Edge (`experimental.EdgeFunction`)** — `compute_construct.ts:289`. Replicates to us-east-1 + all PoPs (slow create, *very* slow delete). Created for Next middleware and `runtime:'edge'` routes. **Manifest-driven, not prop-gated today.**
4. **WAFv2 WebACL + distribution association** — `waf_construct.ts:83`. Adds propagation. Only with `waf.enabled`. *Avoidable in preview.*
5. **`BucketDeployment` asset uploads + `KvKeys` custom resource** — `hosting_construct.ts:1418+`, `kv_keys.ts`. Scales with build size; the ISR seed can approach the 900 s Lambda limit for large fan-outs.
6. **ISR machinery** (DynamoDB tag table + GSI, SQS FIFO + DLQ, revalidation Lambda, seed custom resource) — `hosting_construct.ts:536+`. Many small resources, each a CFN round-trip.
7. **Monitoring** (SNS topic + KMS key + ~5 CloudWatch alarms) — `monitoring_construct.ts`. Default-**on**. Fast to create but pure noise for a preview.
8. **CloudFront `DeployInvalidation`** `AwsCustomResource` — `cdn_construct.ts:1285`. Non-blocking; low cost. Redundant on a first deploy (nothing cached yet).

**Key facts that shape the design:**
- There is **no** stage/environment/sandbox/preview concept anywhere in `hosting` today. Resources are gated only by their own feature props (`domain`, `waf.enabled`, `monitoring.enabled`, `skewProtection.enabled`, `logging.enabled`). A preview flag is a *new* concept.
- The single fork between "cheap" and "expensive" is **`hasCompute`** (`hosting_construct.ts:459`, `cdn_construct.ts:262`). SPA/static ⇒ no Lambda, no API GW, no ISR. SSR ⇒ Lambdas + **API Gateway REST API** (`cdn_construct.ts:408`; *not* a Function URL — Function URLs are only used for image-opt) + cache/origin-request policies + ISR when the manifest asks for it.
- The CloudFront distribution is the one thing every path creates unconditionally, and it is the second-biggest cost after ACM. Any real "seconds not minutes" preview has to confront it.

## 4. Approaches (ranked), with reasons

### A. Trim resources (low risk, keep CloudFront) — but be honest about what's already free

The candidate resources split three ways, and only two of the three are worth a preview flag:

**A0. Already opt-in — not passing them = not wired. A preview flag adds *nothing* here.**
`domain`/ACM/Route53 (#1), `waf` (#4, default off), `buildCache`, `storage.inventory`. A preview app simply doesn't pass these. No feature required.

**A1. Default-*on* — wired unless explicitly disabled. This is the only genuine "trim" value:**
- `monitoring.enabled` — default `true` (`monitoring?.enabled ?? true`): SNS + KMS + ~5 alarms.
- access logging — default `true` (`accessLogging: props.logging?.enabled ?? true`): access-log bucket.
- `skewProtection.enabled` — default `true`: a CloudFront Function.
Today each needs an explicit `{ enabled: false }` in *every* preview app; preview mode flips all three with one switch. Real, but these are cheap-to-create resources, so the wall-clock saving is small.

**A2. Not user-toggleable today — needs new code (overlaps B/C):** skip the first-deploy `DeployInvalidation` (#8); `removalPolicy: DESTROY` (the sandbox path already applies this via a Mixin, so mostly covered).

*Why (honest):* A is near-zero risk and good ergonomics, but it does **not** touch the dominant costs (CloudFront distribution #2, Lambda@Edge #3). A preview mode limited to A would be a convenience, not a speedup. The real acceleration is **B and C** below. *Ceiling of A:* still creates CloudFront + (SSR) API GW.

### B. Move Lambda@Edge to a regional Lambda in preview (medium risk) — *mechanism corrected after investigation*
Kills the us-east-1 `edge-lambda-stack` (#3), the worst create+delete offender for edge apps. Two sub-cases, and the naive "just swap edge→node Lambda" is **wrong** for both — here's what actually holds:

- **B1 — Next middleware: already regional. No feature needed.** OpenNext's default is `middleware.external: false` (middleware runs *inside* the regional server Lambda), and the adapter's auto-generated `open-next.config.ts` doesn't set `middleware` — so there is **no** middleware Lambda@Edge on the normal path. `manifest.middleware` (→ `experimental.EdgeFunction`, `hosting_construct.ts:868`) is populated only if a user hand-writes `external: true`. Preview could force `external: false`, but that means overriding a user's explicit config — low value, skip for v1.
- **B2 — `runtime:'edge'` routes: the real driver, and it *is* degradable — via placement, not runtime.** These come from Next source (`export const runtime = 'edge'`); OpenNext refuses to build them without an edge function block (`nextjs.ts:1090`), so they can't be dropped. But OpenNext `FunctionOptions` exposes `placement: 'regional' | 'global'` *independent* of `runtime: 'edge'` (verified against OpenNext docs). So the lever is: in preview, generate the edge block with **`placement: 'regional'`** (+ a regional converter/wrapper) instead of `'global'`. The edge-runtime bundle then deploys as a **regional Lambda** — no replication, no edge stack.

*Why:* it's the only edge acceleration that survives contact with how OpenNext actually builds. *Cost / risk:* spans three layers — the adapter's `renderEdgeFunctionsBlock` (`nextjs.ts:1172`, currently hardcodes `placement:'global'` + `converter:'aws-cloudfront'`), the OpenNext→manifest origin mapping (`nextjs.ts:2108` `if (origin.type === 'edge')` — a regional-placed function surfaces as a normal `function` origin, so the map changes), and CDN behavior wiring (route the pattern to the regional origin instead of attaching an edge Lambda). Depends on OpenNext regional-edge behavior that **must be validated with a real build/deploy**, not just unit tests. Big win, but not a one-file change.

### C. Bypass CloudFront for the preview URL (high risk / high reward)
Skip the distribution entirely and hand back a direct origin URL:
- **SSR** → expose the **API Gateway REST API** invoke URL (`https://{id}.execute-api.{region}.amazonaws.com/prod/`) directly. Public, HTTPS, deploys in seconds. The OpenNext/Nitro server already handles routing and can serve most static assets; image-opt/edge-cache behaviors are lost (fine for a preview).
- **SPA/static** → S3 origin has no public HTTPS endpoint of its own (bucket is private/OAC). Options: (a) temporary S3 static-website endpoint (HTTP-only, no TLS), (b) a tiny public Lambda **Function URL** that streams objects from the bucket, (c) accept that static previews keep a minimal CloudFront. None is as clean as the SSR case.

*Why:* this is the only path to **seconds**, because it removes cost #2. *Cost:* real divergence from prod (different URL shape, no edge behaviors, SPA story is awkward, API GW `authType`/auth needs to be public), and it exercises a code path prod never uses — so it must be opt-in and sandbox-e2e-tested. **Phase 2, opt-in (`preview: { bypassCdn: true }`).**

### D. Reuse a warm distribution across iterations (free, already partly true)
The per-sandbox stack persists between `npm run sandbox` runs, so 2nd+ deploys are **UpdateStack** (distribution config diff) not Create — already much faster than the first. Worth documenting and *not* destroying the stack between iterations. Combined with Express Mode (§2), incremental preview iterations are already the fast case; the pain is the **first** deploy, which A/B/C target.

### E. Deploy-mechanism levers (already covered by core — listed for completeness)
`--method direct`, `--express`, `--require-approval never`. Nothing for hosting to do here except make sure preview mode is *on* whenever `sandboxMode` is.

## 4b. Scalable architecture — one profile, one seam per knob

A deploy-mode decision can reach **7 levels** of the pipeline, but a maintainable design keeps the *decision* in one place and lets every other level stay dumb:

| Level | Where | Role |
|---|---|---|
| L0 Deploy CLI | `core/src/scripts/sandbox.ts` | deploy method (`--express`, `--method direct`), sets `sandboxMode` context — **done elsewhere** |
| L1 App/stack | `test-apps/*/index.cdk.ts`, `BlocksStack` | reads `sandboxMode`; `RemovalPolicies`/Mixins |
| **L2 Orchestrator** ⭐ | `core/src/hosting.ts` (`Hosting`) | **resolves the profile once; fans out to L3 + L5** |
| L3 Adapter/build | `hosting/src/adapters/*` | framework build config (OpenNext `placement`/`middleware`/`minify`) |
| **L4 Manifest** ⭐ | `hosting/src/manifest/types.ts` | **the contract that carries decisions** (`type`, `placement`, …) |
| L5 L3 construct | `hosting_construct.ts` + sub-constructs | provisioning; honors props + manifest — **never checks "preview"** |
| L6 CDN | `cdn_construct.ts` | origins, behaviors, edge associations, invalidation |

**The `PreviewProfile` seam.** Resolved once at L2 from `{ props.preview, sandboxMode context, per-knob defaults }`:

```ts
export interface PreviewProfile {
  enabled: boolean;
  trimResources: boolean;   // A1: monitoring/logging/skew off
  fastTeardown: boolean;    // A2: DESTROY + skip first-deploy invalidation
  edgeToRegional: boolean;  // B2: runtime:'edge' → placement:'regional'
  bypassCdn: boolean;       // C: SSR → API GW URL, skip distribution (opt-in even in preview)
}
// HostingProps:
preview?: boolean | ({ enabled?: boolean } & Partial<Omit<PreviewProfile, 'enabled'>>);
```

Each knob lands at exactly one seam (table in §5). **Adding a knob = one field + one seam**; the construct branches on the concrete prop/manifest field, never on "preview". `bypassCdn` defaults **off even when preview is on** (it diverges from prod), all others default to `enabled`.

## 5. Recommended design

A single **preview** concept on `Hosting`, defaulting **on** whenever the deploy is a sandbox, overridable explicitly:

```ts
// HostingProps (new field)
preview?: boolean | {
  /** Master switch. Default: derived from `sandboxMode` CDK context. */
  enabled?: boolean;
  /** Phase 2, opt-in: skip the CloudFront distribution and return a direct origin URL. */
  bypassCdn?: boolean;
};
```

Resolution order (so it stays predictable and prod is never affected):
1. explicit `preview.enabled` prop, else
2. `this.node.tryGetContext('sandboxMode') === 'true'`, else
3. `false`.

When `preview` is on, apply these **defaults** (each still overridable by an explicit prop, so nothing is a hard override that could surprise a user who opts back in):

| Setting | Prod default | Preview default | Bucket | Preview adds value? |
|---|---|---|---|---|
| `domain` | as provided | as provided (just don't pass it) | A0 | No — already opt-in |
| `waf.enabled` | off | off | A0 | No — already opt-in |
| `buildCache` / `inventory` | off | off | A0 | No — already opt-in |
| `monitoring.enabled` | **on** | **off** | A1 | Yes — flips a default-on |
| `logging.enabled` (access logs) | **on**¹ | **off** | A1 | Yes — flips a default-on |
| `skewProtection.enabled` | **on** | **off** | A1 | Yes — flips a default-on |
| `DeployInvalidation` (first deploy) | created | skipped | A2 | Yes — new behavior |
| removal policy | retain-ish | **DESTROY** | A2 | Mostly covered by sandbox Mixin |
| middleware Lambda@Edge | internal by default | internal (no change) | B1 | No — already regional |
| `runtime:'edge'` routes | `placement:'global'` | **`placement:'regional'`** | B2 | Yes — the real edge win |
| CloudFront distribution | created | created (P1) / **skipped** if `bypassCdn` (P3) | C | Yes — the real SSR win |

¹ access logging currently defaults on via `accessLogging: props.logging?.enabled ?? true`.

**Takeaway from the bucket split:** A0 rows justify *no* feature. The measurable speedup is B + C (dominant costs) and the deploy-mechanism work in `sandbox-express-mode`; A1 is a cheap-resources convenience. This argues for treating Phase 1 as "flip the A1 defaults + `DeployInvalidation` skip" (small, safe) and putting the real weight on B, then C.

**Phasing:**
- **Phase 1 (approach A + D):** ship the flag and the trim-defaults. Pure wiring, no origin changes, low risk. Measure the delta on a real test-app.
- **Phase 2 (approach B):** edge→regional degradation for Next edge/middleware apps.
- **Phase 3 (approach C, opt-in):** `bypassCdn` for SSR (API GW URL) first; decide the SPA story from measured need.

**Guardrails (per AGENTS.md core rules):** preview mode must never leak into production — it keys off `sandboxMode`, is documented as sandbox-only, and the production deploy path (`deploy.ts`) passes neither the flag nor Express Mode. Any change to the public `HostingProps`/return shape is a **breaking-change surface** and needs maintainer sign-off + a changeset before merge.

## 5b. Implementation status (branch `feat/hosting-preview-mode`)

Landed and unit-tested (`npm test` green; no regressions in the 295 existing hosting/core tests):

- **Seam** — `PreviewProfile` + `resolvePreviewProfile()` in `core/src/hosting.ts`; `HostingProps.preview`; resolved once in the ctor. 8 unit tests in `core/src/hosting-preview.test.ts` cover the precedence matrix.
- **A1** — `trimResources` defaults monitoring/logging/skewProtection off (explicit prop still wins).
- **A2** — `fastTeardown` → new `cdn.deployInvalidation` prop (construct + CDN), gated so the first-deploy invalidation is skipped.
- **B2** — `edgeToRegional`: Next.js adapter (`getAdapter` options → `nextjsAdapter` → `renderEdgeFunctionsBlock`) emits `placement: 'regional'` + regional converter/wrapper and records `placement` on the manifest; `ComputeConstruct` and `HostingConstruct` honor `placement` (build `experimental.EdgeFunction` only for `placement: 'global'`, else a regional Lambda + Function URL). 2 synth tests assert regional → no `edge-lambda-stack`, global → Lambda@Edge preserved.
- **C** — `bypassCdn` scaffolded in the profile; throws a clear "not implemented" error if set.

**Still needs a real deploy to confirm (approach B2's runtime assumption):** whether OpenNext, given `placement: 'regional'` on a `runtime: 'edge'` function, emits a working regional Lambda (correct converter/wrapper for the Function-URL origin) and serves the route. Unit tests validate the CDK wiring, not OpenNext's build output. See §6.

## 6. Experiment plan (§Execution step 3)

Measure Phase-1 savings on a real app in `/Users/osamariz/playground/test-apps` before committing to the design:

- **SPA/static:** `aws-blocks-spa-react-router` (no compute → isolates the CloudFront + trim savings).
- **SSR:** `aws-blocks-next-app-router` (compute + API GW + ISR).
- **Edge (for Phase 2):** `amplify-next-edge-stress` or a Next app with `runtime:'edge'` (isolates Lambda@Edge).

Protocol per app: baseline `npm run sandbox` (cold) → destroy → preview-mode deploy (cold) → compare wall-clock from the deploy timing already logged in `sandbox.ts`. Record CREATE vs UPDATE separately (approach D). Tear every sandbox down with `npm run destroy` when done (AGENTS.md long-lived-process + cost rules).

> Deploying to real AWS costs time and money and touches a live account — not started here without an explicit go-ahead. See §7.

## 7. Open questions for maintainers
1. Is auto-deriving preview from `sandboxMode` the right default, or should preview be strictly explicit?
2. `bypassCdn` (approach C) diverges from prod and adds a prod-unused code path — worth the "seconds" payoff, or is Phase 1 + Express Mode enough?
3. SPA static-preview URL without CloudFront: S3 website (HTTP-only) vs a public Function URL shim vs minimal-CloudFront — which is acceptable?
4. Degrading edge→regional (approach B) silently changes runtime semantics in preview — acceptable, or must it be explicit per app?
