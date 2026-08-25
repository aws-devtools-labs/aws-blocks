---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

Add hosting **preview mode** — a faster deploy for ephemeral environments (PR previews, per-branch sandboxes).

`Hosting` gains a `preview` prop (`boolean` or a per-knob object). It auto-enables when the deploy sets `--context sandboxMode=true` (the sandbox deploy path already does) and is off for production deploys, so the production path is never affected. Resolves once to a `PreviewProfile` and fans out to composable knobs, each landing at a single seam so more can be added without touching the rest:

- **A1 `trimResources`** — skips the always-on, prod-only resources a preview doesn't need: CloudWatch monitoring (SNS/KMS/alarms), CloudFront access logging, and cookie skew protection. An explicit prop (e.g. `monitoring: { enabled: true }`) always wins.
- **A2 `fastTeardown`** — skips the first-deploy CloudFront invalidation (nothing is cached yet on a fresh distribution).
- **B2 `edgeToRegional`** — deploys Next.js `runtime: 'edge'` routes as **regional** Lambdas (`placement: 'regional'`) instead of Lambda@Edge, eliminating the us-east-1 `edge-lambda-stack` and its slow replication/teardown. The Next.js adapter records `placement` on the manifest; the L3 construct honors it (builds `experimental.EdgeFunction` only for `placement: 'global'`).
- **C `bypassCdn`** — for **static/SPA** sites, skips the CloudFront distribution and serves directly from a public S3 static-website endpoint (fresh deploy ~2-3 min vs ~7-8). SSR is not supported yet (throws a clear error until the API-Gateway single-origin path lands). Opt-in even when preview is enabled.

Example:

```ts
// auto: preview when deployed as a sandbox, production otherwise
new Hosting(stack, 'Web', { root, api: blocksStack });

// force preview but keep edge routes on Lambda@Edge
new Hosting(stack, 'Web', { root, preview: { edgeToRegional: false } });

// static/SPA: skip CloudFront entirely (S3 website, seconds to deploy)
new Hosting(stack, 'Web', { root, framework: 'spa', preview: { bypassCdn: true } });
```

**Breaking:** to support `bypassCdn`, `HostingConstruct.distribution` and `HostingResources.distribution` are now **optional** (`undefined` when serving without CloudFront). Code that reads `.distribution` must guard for `undefined`. In `bypassCdn` mode the endpoint is **HTTP-only + public-read** (preview environments only), the same-origin API proxy is unavailable (the frontend calls the API cross-origin — CORS applies), and S3 website returns HTTP 404 (with the index body) for SPA deep-links.

Otherwise additive: omitting `preview` in a non-sandbox deploy preserves today's behavior exactly.
