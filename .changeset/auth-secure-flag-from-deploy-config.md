---
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

`AuthBasic` and `AuthCognito` no longer let a request header decide whether the session cookie is `Secure`. Previously, on a deployed stack, a request that sent `Origin: http://localhost` received a cookie without `Secure` (and, with `crossDomain: true`, without `Partitioned`). The local-dev relaxation now applies only when the process itself is local, as reported by `getDeploymentType()` from deploy configuration. The local dev server (`npm run dev`) behaves as before. A sandbox (`npm run sandbox`) proxies the API to deployed compute, so its cookie now keeps `Secure` (and `Partitioned` with `crossDomain: true`) even though the page is on `http://localhost`, matching `AuthOIDC`.

`@aws-blocks/auth-common/cookies` adds `isLocalDevRequest(ctx)`, the per-request input both BBs now use.
