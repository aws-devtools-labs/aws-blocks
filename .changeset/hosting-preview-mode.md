---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

Add hosting **preview mode** — a fast, cheap, disposable deploy shape for
ephemeral environments (PR previews, per-branch sandboxes, demos).

`Hosting` gains a `preview` prop (`boolean` or a per-knob object). It
auto-enables when the deploy sets `--context sandboxMode=true` (the sandbox
deploy path already does) and is off for production, so the production path is
never affected. It resolves once to a `PreviewProfile` and fans out to
composable knobs, each at a single seam:

- **`trimResources`** — skip prod-only always-on resources a preview doesn't need
  (CloudWatch monitoring/SNS/KMS/alarms, CloudFront access logging, skew
  protection). An explicit prop (e.g. `monitoring: { enabled: true }`) always wins.
- **`fastTeardown`** — skip the first-deploy CloudFront invalidation (nothing is
  cached yet on a fresh distribution).
- **`edgeToRegional`** — deploy Next.js `runtime: 'edge'` routes as **regional**
  Lambdas instead of Lambda@Edge, eliminating the us-east-1 `edge-lambda-stack`
  and its slow replication/teardown.
- **`skipImageOptimization`** — skip the image-optimization Lambda (and, for
  Next.js, the slow `sharp` install). Image endpoints degrade to the **source
  image**.
- **`skipIsr`** — drop the ISR **revalidation** machinery (DynamoDB tag table,
  SQS queue/DLQ, revalidation Lambda) while **keeping the S3 incremental cache +
  build seed**, so pure-SSG and prerendered pages are still served **frozen** at
  build time (SSG is not ISR). ISR pages serve the build snapshot without
  revalidating.
- **`bypassCdn`** (opt-in even under preview) — skip CloudFront entirely and
  serve the whole app from **one API Gateway HTTP API v2 origin** at the domain
  root. Framework-agnostic, routed off the `DeployManifest`.

Under `bypassCdn` the single origin serves everything, **securely and
same-origin**:

- **Static assets** via a small asset-proxy Lambda reading the private S3 bucket
  (`GET/HEAD/OPTIONS`; the browser's crossorigin module loader is handled). Bare
  prerendered pages get a bare route; nested prerendered subtrees resolve via
  directory-index. One api-scoped Lambda invoke-permission keeps the resource
  policy small.
- **SSR** via a **private** `HttpLambdaIntegration` — the Lambda has **no
  Function URL** (no public Lambda endpoint). SSR is **buffered** (HTTP API v2
  can't stream; preview trades away streaming like it trades away CDN caching).
  For `http-server` frameworks (Astro/SvelteKit/Nitro `node-server`) LWA runs in
  `buffered` mode; Nitro (Nuxt) is forced to the `node-server` preset with a
  `run.sh` wrapper; Next is buffered via the `aws-apigw-v2` converter.
- **`/aws-blocks/*` + `/auth/*`** proxied same-origin to the backend API, so
  `SameSite=Lax` cookie auth works with no CORS. The browser client defaults to
  the same-origin RPC prefix when no `apiUrl` is configured.
- **Image endpoints** (`_ipx`, `_next/image`, `_image`, mounted at `basePath`)
  degrade to the original source image; a **remote** source is 302'd to origin
  (the proxy never fetches arbitrary URLs — no SSRF).

**Deploy speed.** Sandbox deploys use CloudFormation **Express Mode**
(`--method direct --express`). Preview **re-deploys hotswap** the Lambdas
(`--hotswap-fallback --express`) once a stack exists, and preview pins a
deterministic `buildId='preview'` so a code-only change produces byte-identical
assets and stays a true hotswap. Measured (nuxt): first deploy ~1.9× faster,
code-only re-deploy ~2.4× faster, teardown ~20×+ faster than the CloudFront
path. Production is unchanged (per-deploy random buildId for atomic zero-downtime
cutover; reviewable change set + full stabilization + rollback).

Validated end-to-end on real deploys across **Next.js, Nuxt, Astro, SvelteKit,
and SPA** — routing, SSR (private, no Function URL), SSG-frozen, same-origin
cookie-auth CRUD, and image fallback.

**Breaking:** `HostingConstruct.distribution` and `HostingResources.distribution`
are now **optional** (`undefined` under `bypassCdn`, where no CloudFront exists);
code reading `.distribution` must guard. Otherwise additive — omitting `preview`
in a non-sandbox deploy preserves today's behavior exactly.

Example:

```ts
// auto: preview when deployed as a sandbox, production otherwise
new Hosting(stack, 'Web', { root, api: blocksStack });

// force preview but keep edge routes on Lambda@Edge
new Hosting(stack, 'Web', { root, preview: { edgeToRegional: false } });

// skip CloudFront entirely — one API Gateway origin (fast, cheap, disposable)
new Hosting(stack, 'Web', { root, framework: 'nextjs', preview: { bypassCdn: true } });
```
