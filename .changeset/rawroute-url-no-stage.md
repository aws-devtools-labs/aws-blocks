---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-auth-oidc": patch
---

fix(core): `ctx.request.url.pathname` no longer includes the API Gateway stage when deployed

On AWS, a `RawRoute` handler's `ctx.request.url` had the API Gateway stage in front of the path (`/prod/bench/me`), while `npm run dev` gave the route path (`/bench/me`). A handler that sub-routed on `url.pathname` passed every local test and returned its own 404 for every request after deploy. Behind `Hosting`, the stage wasn't part of the browser's URL either.

`ctx.request.url.pathname` is now the route path in every environment. The origin is unchanged: on AWS it is still the host the backend received, which behind a front door is the API Gateway host. An HTTP API `$default` stage is no longer prepended either, and a request path starting with `//` no longer changes the URL's host.

This is a `minor` bump because it changes an existing value. If you build an absolute link from `ctx.request.url.pathname` or `href` while clients call the API Gateway URL directly, add the stage yourself, or build the link from your app's configured origin. Building Block authors who need the externally reachable base, stage included, can use the new `getRequestBaseUrl(ctx)` from `@aws-blocks/core/bb-utils`.

`@aws-blocks/bb-auth-oidc` now takes the stage for its fallback callback URL and its stub IdP issuer from `getRequestBaseUrl()`, so those URLs are unchanged.
