---
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": patch
---

`@aws-blocks/auth-common/cookies` adds `isLocalDevRequest(ctx)`, the per-request `isLocalhost` input for the session-cookie security policy. It is `true` only when the process itself is local, as reported by `getDeploymentType()` from deploy configuration, and the request comes from a loopback origin. On deployed compute it is always `false`, so a request that sends `Origin: http://localhost` cannot drop `Secure` (or, with `crossDomain: true`, `Partitioned`) from the cookie. `isLoopbackRequest(ctx)` stays exported and unchanged.
