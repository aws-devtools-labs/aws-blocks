---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

feat(core): add the `apiFrontDoor` prop, the `cloudfront` tier, and `publicApiUrl`

A Blocks app's API is served by the stack's single shared API Gateway REST API. By
default clients call that gateway's own `execute-api` endpoint — the `'apigateway'`
tier. You can now put a Blocks-managed CloudFront distribution in front of it
instead, with a new prop on `BlocksStackProps` / `BlocksBackendProps`:

```ts
await BlocksStack.create(app, 'App', {
  // …
  apiFrontDoor: 'cloudfront', // default: 'apigateway'
});
```

- `'apigateway'` — clients call the API Gateway endpoint directly. Nothing extra to
  deploy; unchanged from before.
- `'cloudfront'` — one CloudFront distribution in front of the gateway (CloudFront →
  API Gateway → Lambda), and the gateway is built as a regional endpoint so there is
  a single CloudFront layer. One catch-all behavior forwards every request to the
  gateway — uncached, all methods, everything except `Host`, HTTP→HTTPS. The
  distribution's URL is published to the runtime as `BLOCKS_PUBLIC_ORIGIN`, so
  absolute URLs the backend builds (such as AuthOIDC's sign-in callback) use it.

**`publicApiUrl`** on `BlocksStack` / `BlocksBackend` is the URL clients should call
under either tier: the CloudFront URL + `/aws-blocks/api` under `'cloudfront'`, else
`apiUrl`. `apiUrl` stays the gateway's own URL (what `Hosting` forwards to). A
`BlocksStack`'s `ApiUrl` output — what `deploy` / `sandbox` hand a client as
`BLOCKS_API_URL` — is `publicApiUrl`; with `BlocksBackend`, emit it yourself. The
Amplify template now publishes `publicApiUrl` as `blocks_api_url`.

The default is a constant `'apigateway'` — it is **never** derived from the app's
shape, so adding or removing Building Blocks never silently changes how the API is
exposed. Any value other than `'apigateway'` or `'cloudfront'` fails synth.

When an app fronts its frontend with `Hosting`, the API is served from Hosting's
distribution; under `'cloudfront'` the managed distribution then stands down — one
distribution, same origin as the frontend, no CORS and no second hop.

⚠️ **Switching tiers — or adding or removing `Hosting` under `'cloudfront'` —
changes the API's endpoint domain.** Browser auth cookies and sessions are bound to
the origin they were set on, so the change signs every user out. (A stable custom
domain, a future feature, would avoid this.) Pick a tier, and decide on Hosting,
before you have real users, and treat a later change as a breaking migration.
