# Hosting Modes — Feature Matrix: Full (CloudFront) vs Preview (no CDN)

An extensive, dimension-by-dimension comparison of the two `@aws-blocks/hosting`
serving modes, so we can document the difference and recommend when to use each.

- **Full mode** (default; `preview` off) — the production topology: **CloudFront**
  distribution + S3 (OAC) + regional/edge Lambda + ISR machinery + image-optimization
  Lambda + optional WAF + custom domain + monitoring. SSR **streams**.
- **Preview mode** (`preview: { bypassCdn: true }`; auto under `--context sandboxMode=true`)
  — a single **API Gateway HTTP API v2** origin at the domain root, **no CloudFront**.
  Static assets are served by a small asset-proxy Lambda reading the private S3
  bucket; SSR is a private Lambda integration; `/aws-blocks/*` + `/auth/*` proxy
  same-origin to the backend. Optimized for **fast, cheap, throwaway** deploys.

> **Framing.** "Preview" in this document means the **no-CDN** (`bypassCdn`)
> configuration, which is how every sample app under `test-apps/aws-blocks-*` is
> deployed. (`preview: true` *without* `bypassCdn` is an intermediate that keeps
> CloudFront but trims ISR/image/monitoring — out of scope here.)
>
> **How to read each item:** *What it is* · *Why it matters* · *Full* · *Preview* ·
> *Notes*. Legend: ✅ full support · ⚠️ works, degraded/partial · ❌ not available
> · ➖ n/a.

---

## Section A — Common hosting functionality

### A1. Build & build-output ingestion
- **What it is** — The framework adapter (Next/OpenNext, Nuxt/Nitro, Astro, SPA)
  locates build output and emits a service-neutral `DeployManifest` (routes,
  static prefixes, compute, cache, image config).
- **Why it matters** — Same input to both modes → behavior differences are in the
  *serving* layer, not the build.
- **Full** ✅ · **Preview** ✅
- **Notes** — Identical adapters and manifest. Preview pins a deterministic
  `buildId='preview'` so code-only redeploys can **hotswap** (see A22).

### A2. Routing
- **What it is** — Mapping request paths to origins (static vs SSR vs backend API).
- **Why it matters** — Wrong routing → 404s, or SSR billed for static assets.
- **Full** ✅ CloudFront cache behaviors (glob patterns + precedence). · **Preview**
  ⚠️ HTTP API v2 routes translated from the same manifest.
- **Notes** — Preview expands each manifest pattern into API-Gateway primitives
  (bare + greedy `{proxy+}`, per-method). Documented edge case: a **dynamic child
  under a prerendered prefix** resolves at the asset proxy (404) rather than
  reaching SSR; bare routes are added only for genuinely prerendered bare pages.

### A3. Static asset origin
- **What it is** — Where static files are served from.
- **Full** ✅ S3 behind CloudFront (OAC), cached at edge. · **Preview** ⚠️ a small
  **asset-proxy Lambda** streams objects out of the private S3 bucket per request.
- **Notes** — Preview keeps the bucket private (no public-read); every asset is a
  Lambda invocation (no edge cache — see A4).

### A4. Edge / CDN caching
- **What it is** — Caching responses at CloudFront PoPs.
- **Why it matters** — Latency, origin offload, cost.
- **Full** ✅ · **Preview** ❌ **no CDN** — every request hits the regional origin.
- **Notes** — This is the defining trade of preview mode: functional, not fast.

### A5. Static generation (SSG — frozen build output)
- **What it is** — Pages prerendered at build time served frozen (no per-request render).
- **Full** ✅ · **Preview** ✅
- **Notes** — `skipIsr` keeps the **incremental cache + build seed**, so pure-SSG and
  prerendered pages are served frozen from the build snapshot in both modes.

### A6. ISR / on-demand revalidation
- **What it is** — Time-based + tag-based background regeneration of pages.
- **Why it matters** — Fresh content without a full redeploy.
- **Full** ✅ (DynamoDB tag table + SQS queue + revalidation Lambda). · **Preview**
  ❌ revalidation infra trimmed — pages serve the **build snapshot** and don't revalidate.
- **Notes** — Previews are throwaway; revalidation isn't needed. SSG stays frozen (A5).

### A7. Image optimization
- **What it is** — On-the-fly resize/format via a Sharp Lambda.
- **Full** ✅ Sharp Lambda at `/_next/image`, `/_ipx/*`, `/_image`. · **Preview** ❌
  degrades to the **original source image** (unoptimized); a **remote** source is
  302'd to origin (no server-side fetch → no SSRF).
- **Notes** — `<img>` still renders; sizes just aren't distinct.

### A8. Streaming SSR
- **What it is** — Progressive/chunked response as the server renders.
- **Why it matters** — TTFB, large/streamed payloads, SSE.
- **Full** ✅ (CloudFront + Lambda response streaming). · **Preview** ❌ **buffered**.
- **Notes** — HTTP API v2 cannot stream. Rootless + streaming + private don't
  coexist in one AWS primitive (REST API streams but forces a `/{stage}` path
  needing a custom domain/CloudFront; a public Function URL is a security risk).
  Streaming's home is the production/no-CDN-with-custom-domain path.

### A9. SSR runtime / serving
- **Full** ✅ regional or Lambda@Edge, streaming. · **Preview** ⚠️ regional Lambda,
  **buffered** (LWA `buffered` for http-server; OpenNext `aws-apigw-v2` buffered).
- **Notes** — Nitro is forced to the `node-server` preset under preview.

### A10. Edge compute (Lambda@Edge / CloudFront Functions)
- **What it is** — Code at the edge (redirects, header rewrites, edge API routes).
- **Full** ✅ · **Preview** ❌ (`edgeToRegional` downgrades edge routes to regional;
  no CloudFront to host CF Functions).

### A11. Security response headers / CSP
- **Full** ✅ CloudFront response-headers policy. · **Preview** ❌ (API Gateway
  passthrough; no managed security-headers layer).

### A12. WAF / rate limiting
- **Full** ✅ optional WebACL on CloudFront. · **Preview** ❌ (AWS WAF does not
  support HTTP API v2).

### A13. Compression (gzip / brotli)
- **Full** ✅ CloudFront on-the-fly. · **Preview** ❌ (asset proxy serves raw bytes).

### A14. Custom domain / TLS
- **Full** ✅ CloudFront + ACM (+ Route 53). · **Preview** ❌ raw
  `*.execute-api.<region>.amazonaws.com` host only.

### A15. HTTP method semantics
- **Full** ✅ all methods via CloudFront. · **Preview** ⚠️ `GET/HEAD/OPTIONS` on
  static routes → asset proxy (HEAD stripped, OPTIONS → 204 preflight); write
  methods fall through to SSR.

### A16. Same-origin API / cookie auth
- **What it is** — `/aws-blocks/*` + `/auth/*` served from the same origin so
  `SameSite=Lax` cookies flow with no CORS.
- **Full** ✅ (CloudFront behavior). · **Preview** ✅ (HTTP proxy to the backend API).

### A17. Observability (alarms / dashboards / logs)
- **Full** ✅ CloudWatch alarms + dashboards + access logs. · **Preview** ❌
  (`trimResources` drops monitoring/logging).

### A18. Skew protection (version pinning)
- **What it is** — `__dpl`-style pinning of a session to its build.
- **Full** ✅ · **Preview** ❌ (`trimResources`).

### A19. Response / payload limits
- **Full** ✅ large responses + streaming (>10 MB via stream). · **Preview** ⚠️ HTTP
  API v2 buffered (~6 MB Lambda payload cap; no streaming; no >6 MB responses).

### A20. Resource footprint & teardown
- **Full** — heavier: CloudFront distribution, S3+OAC, ISR (DDB/SQS/worker), image
  Lambda, optional WAF, monitoring. · **Preview** — lighter: HTTP API v2 + one
  asset-proxy Lambda + SSR Lambda + S3; **fast teardown** (no CloudFront to
  delete/propagate).

### A21. Cost
- **Full** — CloudFront + ISR infra (DDB/SQS/worker) + image Lambda + requests. ·
  **Preview** — no CloudFront, no ISR infra, no image Lambda; API Gateway + Lambda
  requests only. Materially cheaper for low-traffic throwaway environments.

### A22. Deployment speed & atomicity
- **Full** — first deploy creates a CloudFront distribution (creation +
  propagation); full CloudFormation on every deploy. · **Preview** — no CloudFront →
  fast; **hotswap** applies code-only changes to the Lambdas in seconds; Express
  mode for infra changes. **Quantified in the PR benchmark below / PR description.**

---

## Section B — Framework-specific behavior per mode

### B1. Next.js (App Router & Pages Router, via OpenNext)
- **Full** — ISR + `/_next/image` optimization + streaming SSR; edge API routes on Lambda@Edge.
- **Preview** — SSG frozen; **no ISR revalidation**; `/_next/image?url=` → source image
  (remote → 302); **buffered** SSR (`aws-apigw-v2` converter); edge routes → regional.

### B2. Nuxt / Nitro (and other Nitro presets)
- **Full** — Nitro `aws-lambda` streaming preset; `/_ipx/*` optimization.
- **Preview** — Nitro `node-server` preset behind LWA (buffered) + `run.sh`; `/_ipx/*`
  → source image; prerendered pages served frozen from S3 via directory-index.

### B3. Astro
- **Full** — SSR streaming + `/_image` optimization Lambda.
- **Preview** — buffered SSR; `/_image?href=` → source; static multipage served via the
  asset-proxy's directory-index (`/about` → `about/index.html`).

### B4. SPA / static-only
- **Full** — S3 + CloudFront. · **Preview** — asset proxy with SPA fallback
  (unknown route → `index.html`). Behavior identical to the user; no CDN cache.

---

## Section C — Summary matrix

| Dimension | Full (CloudFront) | Preview (no CDN) |
|---|---|---|
| Build & manifest ingestion | ✅ | ✅ |
| Routing | ✅ behaviors | ⚠️ API GW route expansion |
| Static asset origin | ✅ S3+OAC (edge) | ⚠️ asset-proxy Lambda (per request) |
| Edge/CDN caching | ✅ | ❌ |
| SSG (frozen) | ✅ | ✅ |
| ISR / revalidation | ✅ | ❌ |
| Image optimization | ✅ | ❌ (source image) |
| **Streaming SSR** | ✅ | ❌ (buffered) |
| Edge compute (L@E / CF Fn) | ✅ | ❌ |
| Security headers / CSP | ✅ | ❌ |
| WAF / rate limit | ✅ | ❌ |
| Compression (gzip/br) | ✅ | ❌ |
| Custom domain / TLS | ✅ | ❌ |
| HTTP methods | ✅ | ⚠️ GET/HEAD/OPTIONS→asset; writes→SSR |
| Same-origin cookie auth | ✅ | ✅ |
| Observability / alarms | ✅ | ❌ |
| Skew protection | ✅ | ❌ |
| Response/payload limit | ✅ large + stream | ⚠️ ~6 MB, no stream |
| Resource footprint | heavier | lighter |
| Teardown speed | slower (CloudFront) | fast |
| Cost | higher | lower |
| First-deploy time | slower (CloudFront) | faster |
| Redeploy time | full CFN | hotswap / Express |

---

## Section D — Deployment benchmark

Measured on **nuxt** (`test-apps/aws-blocks-nuxt`), us-west-2, single sample,
warm build cache. Wall-clock = full `deploy`/`sandbox` command (build + synth +
deploy + client-gen), wrapped in `date +%s`. Method: fresh stacks
(`stress-nuxt-prod-bench` full, `stress-nuxt-…-benchpv` preview); redeploy =
one-line code change (no infra change).

| Scenario | Full (CloudFront) | Preview (no CDN) | Speedup |
|---|---|---|---|
| First deploy (fresh stack) | **378 s** (6m18s) | **202 s** (3m22s) | **1.9×** |
| Redeploy (code-only) | **263 s** (4m23s) | **108 s** (1m48s) | **2.4×** |
| Redeploy (infra change) | ~263 s (full CFN) | ~145–157 s (Express) | ~1.7× |
| Teardown | ~15–20 min (CloudFront delete) | **48 s** | ~20×+ |

Notes:
- Full mode runs a full CloudFormation deploy every time (CloudFront distribution
  create/propagate on first deploy; full changeset on redeploy).
- Preview code-only redeploy **hotswaps** the Lambdas; the ~108 s is dominated by
  the ~77 s S3 asset re-upload, not CloudFormation.
- Single app / single sample. A heavier full-mode app (e.g. Next.js with ISR +
  image-opt + Lambda@Edge) widens the gap further (more CFN resources + a
  us-east-1 edge stack on the full side).

---

## Section E — When to use which (customer guidance)

**Use Preview (no CDN) when:**
- You want the **fastest, cheapest, disposable** environment (PR previews, sandboxes,
  local-to-AWS parity checks, demos).
- You need to validate **functionality** end-to-end (routing, SSR, same-origin auth,
  data) — not performance.
- You're iterating: code-only changes **hotswap** in seconds.

**Use Full (CloudFront) when:**
- You're serving **production** traffic — you need edge caching, streaming SSR, image
  optimization, ISR, compression, security headers, WAF, and a custom domain.
- Latency / TTFB and origin offload matter.
- You need version/skew protection and full observability.

**Rule of thumb:** Preview trades away **performance and edge features** (caching,
streaming, image-opt, WAF, custom domain) but preserves **functionality**. Every
"❌" in the matrix is an optimization or an edge-only capability — none of them
change whether the app *works*. Promote to Full for production.
