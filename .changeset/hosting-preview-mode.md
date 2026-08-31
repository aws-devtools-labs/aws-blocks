---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

Add hosting **preview mode** — a fast, cheap, disposable deploy shape for
ephemeral environments (PR previews, per-branch sandboxes, demos).

`Hosting` gains a `preview` prop: `true`/`false`, or a small object of
**service-neutral capabilities** to keep (`PreviewOverrides`). Preview is
**strictly opt-in** — omitting the prop (the default) deploys today's full
production shape in every stage, sandbox and production alike. It only ever
affects a deploy when you turn it on, so existing apps are untouched.

**The public surface is intent, not infrastructure** — it never exposes
framework or AWS-topology terms. One rule: preview scales everything down; name
a capability to keep it.

- **`cdn`** — keep a content-delivery layer (edge caching, WAF, custom domain,
  streaming responses). **Off by default** in preview: the app is served from a
  single regional origin at the domain root (responses buffered). `cdn: true`
  opts up to a CDN-fronted, production-like preview. A synth **warning** fires if
  the no-CDN shape runs on a non-sandbox deploy (it's a preview shape, not for
  production traffic).
- **`imageOptimization`** — keep on-the-fly image optimization. **Off by
  default**: images are served unoptimized from their source.

Everything else always scales down in preview with no public toggle yet
(response caching / incremental regeneration, monitoring/logging/alarms, and
Next.js `runtime:'edge'` routes → regional) — these can be surfaced as
capabilities post-release if asked. Internally the resolver maps capabilities to
per-service infrastructure; that mapping is an implementation detail.

With the CDN off (the default), one origin serves everything, **securely and
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

**Deploy speed.** Building on the sandbox Express-Mode deploy, preview
**re-deploys hotswap** the Lambdas (`--hotswap-fallback --express`) once a stack
exists, and preview pins a
deterministic `buildId='preview'` so a code-only change produces byte-identical
assets and stays a true hotswap. Measured (nuxt): first deploy ~1.9× faster,
code-only re-deploy ~2.4× faster, teardown ~20×+ faster than the CloudFront
path. Production is unchanged (per-deploy random buildId for atomic zero-downtime
cutover; reviewable change set + full stabilization + rollback).

Validated end-to-end on real deploys across **Next.js, Nuxt, Astro, SvelteKit,
and SPA** — routing, SSR (private, no Function URL), SSG-frozen, same-origin
cookie-auth CRUD, and image fallback.

**Breaking:** `HostingConstruct.distribution` and `HostingResources.distribution`
are now **optional** (`undefined` when a preview runs without a CDN, where no
CloudFront exists); code reading `.distribution` must guard. Otherwise additive —
omitting `preview` in a non-sandbox deploy preserves today's behavior exactly.

Example:

```ts
// default: full production shape in every stage (preview off)
new Hosting(stack, 'Web', { root, api: blocksStack });

// opt in to the cheapest preview (no CDN, no cache, no image optimization)
new Hosting(stack, 'Web', { root, framework: 'nextjs', preview: true });

// production-like preview: keep the CDN (CloudFront, custom domain, streaming)
new Hosting(stack, 'Web', { root, framework: 'nextjs', preview: { cdn: true } });
```
