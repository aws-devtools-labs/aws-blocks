# @aws-blocks/hosting

## 0.1.10

### Patch Changes

- dd2350b: Trim the `KvKeys` custom resource IAM policy to true least privilege: it now grants only `cloudfront-keyvaluestore:DescribeKeyValueStore` and `UpdateKeys` — the two actions the deploy-time handler actually calls. The previously-granted `ListKeys`, `GetKey`, `PutKey`, and `DeleteKey` are dropped.
  
  This also makes the hosting stack deployable under restrictive Service Control Policies (SCPs) / permission boundaries that deny `cloudfront-keyvaluestore:ListKeys`, which previously blocked the deploy.
  
  Behavior is preserved: `ListKeys` was only used to diff against the live store on Create, but the route-table `KeyValueStore` is created fresh with no `ImportSource`, so it is empty at Create time — the handler now diffs Create against `{}`. The Update path still diffs against the prior template's entries and Delete still drains via `deleteDrainSet()`, neither of which used `ListKeys`.

## 0.1.9

### Patch Changes

- 940956e: fix(hosting): encrypt the alarm SNS topic by default, with a key policy CloudWatch can actually use
  
  The monitoring construct's auto-created alarm topic was unencrypted. It now gets
  a dedicated customer-managed KMS key (`MonitoringAlarmTopicKey`) whose policy
  grants `cloudwatch.amazonaws.com` `kms:Decrypt` + `kms:GenerateDataKey*` in
  addition to the usual account-root administration statement.
  
  Both halves matter. Encrypting the topic makes hosting secure-by-default, and
  the CloudWatch grant is what keeps alarms working once it is encrypted: when an
  SNS topic used as a CloudWatch alarm action is KMS-encrypted, the key policy
  must grant the `cloudwatch.amazonaws.com` service principal, because CloudWatch
  calls KMS **directly** (not via SNS) and an account-root `kms:*` statement does
  not cover AWS service principals. Without the grant, CloudWatch's publish fails
  with `KMSAccessDenied` and notifications are dropped silently — the alarm still
  transitions to ALARM in the console, so the only symptom is the notification
  that never arrives.
  
  An AWS-managed key (`alias/aws/sns`) cannot be used instead: its key policy is
  not editable and does not grant CloudWatch, so a customer-managed key is the
  only option that can carry the grant.
  
  The grant is scoped to just those two actions for that one service principal on
  a single-purpose key, plus a `StringEqualsIfExists` guard on `aws:SourceAccount`
  against cross-account confused-deputy use. `IfExists` is deliberate:
  `aws:SourceAccount` is only populated on direct service-principal calls, and a
  hard `StringEquals` would reintroduce the very silent deny this grant exists to
  prevent.
  
  No configuration changes: encryption is unconditional, with no opt-out knob to
  weaken it. The only API addition is a read-only `encryptionKey` accessor on
  `MonitoringConstruct`, alongside the existing `topic` and `alarms`, so callers
  can grant additional publishers on the key. Callers who need different key
  management continue to pass their own `snsTopic` / `snsTopicArn` and own that
  topic's encryption. Note the KMS key adds roughly $1/month per stack, and
  monitoring is on by default; `monitoring: { enabled: false }` or a BYO topic
  avoids it.
- 4981137: fix(hosting): disable installLatestAwsSdk on the CDN invalidation custom resource
  
  The `DeployInvalidation` `AwsCustomResource` in `CdnConstruct` left
  `installLatestAwsSdk` at its CDK default of `true`. That default makes the
  custom-resource provider Lambda `npm install` the AWS SDK at invoke time,
  adding roughly 15-30s of cold start and forcing a 512MB memory floor on the
  provider function.
  
  Nothing here needs a newer SDK than the runtime ships. The resource makes a
  single `CloudFront.createInvalidation` call — a long-stable API already bundled
  in the Lambda runtime's AWS SDK v3. And unlike a one-off resource, this one
  fires on *every* hosting deploy (its `CallerReference`/`physicalResourceId` are
  keyed on `buildId`), so the install cost was paid on every deploy rather than
  once.
  
  Setting `installLatestAwsSdk: false` removes that per-deploy penalty and also
  silences CDK's `installLatestAwsSdkNotSpecified` warning for this construct.
  No public API or template change beyond the `InstallLatestAwsSdk: false`
  property on the synthesized `Custom::AWS` resource; invalidation behavior,
  IAM policy, and deploy ordering are unchanged.
- 5c58c53: fix(hosting): deploy SSR framework Lambdas on nodejs24.x and throw on unrecognized runtimes instead of silently falling back to nodejs20.x
  
  SSR framework compute (Nuxt/Nitro, Astro, SvelteKit, Next.js regional) now runs on
  `nodejs24.x` via a shared `FRAMEWORK_COMPUTE_RUNTIME` constant, and `resolveRuntime()`
  recognizes `nodejs24.x`, defaults to it when no runtime is declared, and throws
  `UnsupportedRuntimeError` for unrecognized runtimes rather than silently returning
  Node 20. Lambda@Edge compute (`FRAMEWORK_EDGE_COMPUTE_RUNTIME`) is bumped to
  `nodejs24.x` as well: Lambda@Edge draws Node.js versions from the same managed runtime
  table as regional Lambda, where `nodejs24.x` is supported and `nodejs20.x` is already
  past deprecation. The OpenNext edge bundle banner patch was revalidated — the crash it
  works around comes from ES Module namespace exports being non-writable per spec, not
  from any Node-20-specific behavior.

## 0.1.8

### Patch Changes

- 0284e5b: fix(hosting): serve HTML from the current build after a deploy (fixes returning-visitor blank page)

  Returning visitors — browsers holding a `__dpl` skew-protection cookie from a
  previous build — got a blank page on their first load after every deploy (a
  second reload fixed it). The KVS router's viewer-request function honored the
  `__dpl` cookie for **all** URIs including HTML, so a returning visitor was served
  the **old** build's HTML, while the viewer-response function stamped `__dpl` with
  the **current** build on every HTML response. The old HTML references
  content-hashed assets that only exist under the old build's prefix; with the
  cookie now advanced to the new build, those asset requests were rewritten to
  `/builds/<newBuildId>/…<oldHash>` (which does not exist) and failed (403 on
  0.1.4, 404 on ≥ 0.1.5), rendering a blank page.

  The viewer-request function now resolves HTML documents from the current build
  (`meta.b`), never a pinned cookie build, while assets keep honoring the cookie.
  HTML, cookie, and referenced assets therefore always agree on one build
  generation. Mid-session visitors stay safe: asset requests keep honoring their
  old cookie and old `builds/<id>/` prefixes are retained (`prune: false`), so an
  already-loaded page keeps working until the next HTML navigation lands the
  visitor consistently on the current build.

## 0.1.7

### Patch Changes

- b09e568: Add a SvelteKit framework adapter. SvelteKit apps are now auto-detected (via
  `@sveltejs/kit`) and deployed through `@sveltejs/adapter-node` running on Lambda
  behind the Lambda Web Adapter (the existing `http-server` compute path), fronted
  by CloudFront + S3. Supports SSR pages, `+server.js` endpoints, form actions,
  server `load`, `hooks.server`, streaming, prerendered/SSG pages (served frozen
  from S3), custom headers, cookies, redirects, `error()`, and `paths.base`. A
  transparent build bridge wires `@sveltejs/adapter-node` when the app hasn't
  configured it, so no manual setup is required. Patch (not minor) per the
  pre-1.0 caret convention — the change is additive and backward-compatible.

## 0.1.6

### Patch Changes

- 9586841: docs(hosting): document custom domain configuration (Route 53 and bring-your-own DNS)

## 0.1.5

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

- 71eb746: Verify the Next.js adapter against OpenNext 4.0.x. An OpenNext 4.0.3 integration deploy confirmed all four bundle patches (streaming wrapper, edge-bundle process banner, `fetchInternalImage` arity insertion, and SVG-status catch rewrite) still match the 4.0.x minified shape, and the live app served optimized rasters, a fail-closed SVG (400), edge routes, and redirects with no regressions. `VERIFIED_OPENNEXT_RANGE` now covers `>=3.10.0 <3.11.0 || >=4.0.0 <4.1.0` so apps on OpenNext 4.0.x no longer trip the out-of-range warning.

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
