---
"aws-blocks-swift": minor
---

feat(swift): call each API namespace at its own path

`BlocksClient` now POSTs a call to `{url}/{namespace}` — for example
`…/aws-blocks/api/reports` for `reports.build` — instead of the shared
`/aws-blocks/api`, the same path the TypeScript client uses. The backend's API
gateway routes by path, so a namespace that runs on its own compute is now served
by that compute when called from Swift too; until now every Swift call ran on the
app's default compute. The JSON-RPC body is unchanged.

Deploy the backend with `@aws-blocks/core` 0.8.0 or later before shipping an app
built with this version: an older backend serves only `/aws-blocks/api` and
rejects the per-namespace path. If you run your own proxy in front of the API,
make it forward the whole `/aws-blocks/api/*` subtree.
