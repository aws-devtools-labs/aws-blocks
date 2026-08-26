---
"@aws-blocks/hosting": patch
---

Fix `bypassCdn` SSR for non-Next frameworks (Nuxt/Astro/SvelteKit) — securely,
with no public Function URL.

`bypassCdn` fronts the SSR catch-all with a **private** API Gateway HTTP API v2
`HttpLambdaIntegration` (the Lambda is invoked only by API Gateway, never
exposed via a Function URL). That integration is a **buffered** invoke, which
only Next's OpenNext `aws-apigw-v2` handler produced correctly; other
frameworks' SSR returned a streamed/`Transfer-Encoding: chunked` response the
buffered invoke can't parse → 500 (static assets still served).

Preview trades away SSR **streaming** (a performance feature, like CDN caching /
image-opt) for a functional, secure single origin. Per compute type under
`bypassCdn`:

- **Lambda Web Adapter (`http-server`)** — Astro, SvelteKit, Nitro `node-server`:
  run LWA in `buffered` mode (`AWS_LWA_INVOKE_MODE=buffered`) instead of
  `response_stream`, via a new `ComputeConstruct.bufferedInvoke` prop the L3
  sets for the SSR compute.
- **Nitro (`aws-lambda`)** — Nuxt/Analog/etc.: force the `node-server` preset
  (an `http-server` compute) so SSR ignores `awsLambda.streaming` and runs
  buffered behind the private integration. The adapter writes a `run.sh`
  wrapper into the bundle (`exec node index.mjs`) so the LWA `/opt/bootstrap`
  can start the server — mirroring the Astro/SvelteKit adapters.
- **Next** — unchanged (already buffered via the `aws-apigw-v2` converter).

Validated on a real deploy (Nuxt): SSR `GET /` 500 → 200 (renders),
`/nonexistent` → 404, `POST /` → 200 (bodies forwarded), same-origin
`/aws-blocks/api` → 200, static `/_nuxt/*` → 200 — with the SSR Lambda having
**no Function URL** (private, invoked only by API Gateway). No public endpoint,
no CloudFront OAC, so the OAC POST-body signature bug cannot occur.
