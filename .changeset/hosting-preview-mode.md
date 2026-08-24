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
- **C `bypassCdn`** — reserved (skip the CloudFront distribution and serve the SSR origin directly). Scaffolded but not yet implemented; setting it throws a clear error.

Example:

```ts
// auto: preview when deployed as a sandbox, production otherwise
new Hosting(stack, 'Web', { root, api: blocksStack });

// force preview but keep edge routes on Lambda@Edge
new Hosting(stack, 'Web', { root, preview: { edgeToRegional: false } });
```

Additive and non-breaking: omitting `preview` in a non-sandbox deploy preserves today's behavior exactly.
