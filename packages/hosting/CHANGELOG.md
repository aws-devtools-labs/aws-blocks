# @aws-blocks/hosting

## 0.1.4

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

## 0.1.3

### Patch Changes

- 162c47d: fix(hosting): stop hardcoding image-optimization Lambda reserved concurrency

  The image-optimization Lambda hardcoded `reservedConcurrency: 10`, which made `cdk deploy` fail on fresh AWS accounts (the default account-level unreserved-concurrency limit is also 10, so reserving all 10 drops the account below its required minimum and Lambda returns a 400). It now defaults to no reservation and exposes `compute.imageOptimization.reservedConcurrency` so operators with headroom can still cap it.

## 0.1.2

### Patch Changes

- 42adb51: Fix multi-page routing for static sites (Astro static, SSGs). The L3 no longer infers SPA-vs-multi-page from the presence of error pages; adapters now declare `staticAssets.spaFallback` explicitly. The Astro adapter sets `spaFallback: false` (static Astro is always multi-page), and the generic adapter sources it from the framework contract (`spa` → single-page, `static` → multi-page). Multi-page static sites without their own `404.html` now get a built-in default 404 page (served at HTTP 404) instead of CloudFront's raw error. Adds a `hosting-ssr-astro` e2e test app.

  **Migration**: If you were passing `framework: 'static'` and relied on SPA-fallback routing (extensionless paths → /index.html), switch to `framework: 'spa'`. `framework: 'static'` now always produces multi-page directory-index resolution.

- 061a0b2: fix(hosting): make redeploys atomic by uploading assets before the CloudFront build-id cutover, eliminating the 403 window for new visitors during deployment

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements

## 0.1.0

Initial version
