# SvelteKit — Per-framework Hosting Test Matrix

> Append this section to `docs/01-test-matrix.md` in
> **osama-rizk/ssr-hosting-foundations** (after the Nuxt/Astro matrices).
>
> Runtime: `@sveltejs/adapter-node` on Lambda via the Lambda Web Adapter
> (`http-server` compute), fronted by CloudFront + S3. Same topology as the
> Astro SSR (`@astrojs/node`) and Nuxt `node-server` paths.
>
> Layer keys: **VR** = CF Viewer-Request Function, **RHP** = Response Headers
> Policy, **S3** = S3+OAC, **API** = REST API GW → SSR Lambda (LWA), **FURL** =
> Function URL.

### SK1 — Rendering & origin selection

| ID | What we test | Request | Expected | Layer | Why |
|---:|---|---|---|---|---|
| SK1.1 | SSR page served by compute | `GET /ssr` | 200, body has `ssr-marker`, `x-amzn-RequestId` present, `renderedAt` changes per request | API → Lambda | Server `load` runs on every request through the LWA-fronted Lambda. |
| SK1.2 | Prerendered page frozen on S3 | `GET /about` twice | 200, `about-marker`, identical `about-build-ts` both times, no compute marker | VR → S3 | `export const prerender = true` → built to HTML, served from S3, never re-rendered. |
| SK1.3 | Hashed asset immutable from S3 | `GET /_app/immutable/<hash>.js` | 200, `cache-control: …immutable` (or max-age ≥ 5 digits), no compute marker | VR → S3 | `_app/immutable/*` is content-hashed; must cache forever and never hit Lambda. |
| SK1.4 | Static file served from S3 | `GET /robots.txt` | 200, `content-type: text/plain` | VR → S3 | Files under `static/` upload as S3 objects and route to S3. |
| SK1.5 | Catch-all hits SSR | `GET /some/unknown/deep/path` | SvelteKit 404 page rendered by the Lambda | API → Lambda | Catch-all `/* → default` terminates at compute. |

### SK2 — Server endpoints & actions

| ID | What we test | Request | Expected | Layer | Why |
|---:|---|---|---|---|---|
| SK2.1 | `+server.js` GET returns JSON | `GET /api/echo?x=1` | 200, `{"method":"GET",…}`, `x-sk-endpoint: echo` | API → Lambda + RHP | API endpoints run server-side; per-endpoint response headers survive the edge. |
| SK2.2 | `+server.js` POST echoes body | `POST /api/echo {ping:"pong"}` | 200, body contains `pong` | API → Lambda | POST bodies reach the SSR Lambda through API GW (payload passthrough). |
| SK2.3 | `+server.js` DELETE | `DELETE /api/echo` | 200, `{"deleted":true}` | API → Lambda | All HTTP verbs proxy correctly (no verb dropped at the edge). |
| SK2.4 | Form action POST round-trips | POST `/form` with `name=Sveltey` | Rendered result `Hello, Sveltey!` | API → Lambda | Form actions require a running server; cannot be prerendered. |

### SK3 — Streaming, headers, cookies, redirects, errors

| ID | What we test | Request | Expected | Layer | Why |
|---:|---|---|---|---|---|
| SK3.1 | Streamed promise in `load` | `GET /streaming` | Shell (`shell-ready`) renders immediately; deferred `streamed-*` streams in | API (LWA response_stream) | Validates response streaming end to end (LWA `AWS_LWA_INVOKE_MODE=response_stream`). |
| SK3.2 | Custom header + origin cache | `GET /headers` | `x-stress-test: on`, `cache-control: s-maxage=120,…` | RHP / CDN cache | Per-response headers + origin `s-maxage` honored by CloudFront. |
| SK3.3 | Cookie round-trip via hooks | `GET /api/whoami` | `Set-Cookie: sk_visit=…`; value readable next request | API → Lambda | `hooks.server` runs on every dynamic request; cookies survive CF → Lambda. |
| SK3.4 | Server redirect | `GET /redirect` | 30x, `location` → `/about` | API → Lambda | `redirect()` from server `load` returns a real 30x (built from `x-forwarded-host`/`-proto`). |
| SK3.5 | `error()` returns real status | `GET /error-demo` | 500, `+error.svelte` body, no leaked stack (`/var/task`, `.js:line:col`) | API → Lambda | Framework error boundary surfaces the correct status without leaking internals. |

### SK4 — base path (variant app, `paths.base` set)

| ID | What we test | Request | Expected | Layer | Why |
|---:|---|---|---|---|---|
| SK4.1 | Bare root redirects to base | `GET /` (base `/app`) | 308 → `/app/` | VR | `manifest.basePath` canonical-form redirect. |
| SK4.2 | base path resolves | `GET /app/ssr` | 200, SSR page | VR + prefixed behaviors | Behaviors prefixed with base. |
| SK4.3 | base stripped before S3 | `GET /app/_app/immutable/<hash>.js` | 200 from S3 key without `/app` | VR (KVS router strip) | S3 keys are stored un-prefixed. |

### Not applicable to SvelteKit

- **Runtime image optimization** — SvelteKit has no `/_next/image` equivalent.
  `@sveltejs/enhanced-img` is build-time only, so there is no image-opt Lambda
  and no `manifest.imageOptimization` (unlike Next/Nuxt/Astro).
