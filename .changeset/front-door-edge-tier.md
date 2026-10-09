---
"@aws-blocks/core": minor
"@aws-blocks/blocks": patch
---

feat(core): add the `apiFrontDoor` selection surface and the `edge` (CloudFront) tier

A Blocks app's API is served by the stack's single shared HTTP API v2 gateway. By
default it is reached directly on that gateway's own regional endpoint — the new
`'regional'` tier. You can now put a global, CDN-backed CloudFront distribution in
front of it instead with a new prop on `BlocksStackProps` / `BlocksBackendProps`:

```ts
await BlocksStack.create(app, 'App', {
  // …
  apiFrontDoor: 'edge', // default: 'regional'
});
```

- `'regional'` — the shared regional gateway, reached directly. Cheap, and a
  stable address for a given deployment (no CDN hop).
- `'edge'` — one CloudFront distribution in front of that gateway (CloudFront →
  API Gateway → Lambda), serving the API from a global, CDN-backed domain with
  edge termination. One catch-all behavior forwards every request to the gateway
  origin — uncached, all methods, forwards everything except `Host`, HTTP→HTTPS.
  In `edge` mode the `ApiUrl` stack output (what `deploy` / `sandbox` hand a client
  as `BLOCKS_API_URL`) resolves to the CloudFront URL + `/aws-blocks/api`.

The default is a constant `'regional'` — it is **never** derived from the app's
shape, so adding or removing Building Blocks never silently changes how the API is
exposed.

When an app fronts its frontend with `Hosting`, the API is served from Hosting's
distribution and the standalone `edge` distribution stands down automatically —
one distribution, same origin as the frontend, no CORS and no second hop. The
claim is recorded on the backend instance Hosting is given, so this holds even
when `Hosting` and its backend live in different stacks.

⚠️ **Switching `'regional'` ⇄ `'edge'` changes the API's endpoint domain.** Browser
auth cookies and sessions are bound to the origin they were set on, so a switch
signs every user out — they must sign in again. (A stable custom domain, a future
feature, would avoid this.) Pick a tier before you have real users, and treat a
later change as a breaking migration.
