---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

feat(bb-auth): same-origin landing paths after sign-in and sign-out, checked against open redirects

`Auth` sends a user back to your app after federated sign-in (`GET /aws-blocks/auth/signin/<provider>?redirectPath=…`, or `getSignInUrl(…, { redirectPath })`) and after sign-out. Every landing path (`redirectPath`, `redirects.postSignInPath` and `redirects.postSignOutPath`) goes through one check, so a sign-in link on your domain can't send users to another site — including with paths browsers rewrite, such as `/%09/evil.example.com` (a TAB that the browser strips from the `Location` header). A path is accepted only if it starts with a single `/`, contains no control characters (TAB, CR, LF, NUL, DEL) and no backslash, and still resolves to your app's origin after URL parsing, including after dot segments like `/.//` collapse. The redirect always uses that normalised path (path, query and hash), never the raw string. The sign-in route answers an unsafe `redirectPath` with `400` (`InvalidParameter`). An unsafe `postSignInPath` or `postSignOutPath` fails at construction. If a pending sign-in cookie carries an unsafe path, the callback re-checks it and lands on `postSignInPath`. Legitimate paths work, with any query and fragment kept.

`stubIdp()` providers are local-only by default: synthesizing a stack with one fails with "`stubIdp()` is local-only; use a real `oidcProviders` entry for deployed stacks", unless the provider opts in with `unsafeAllowDeployed: true` (see the `stubIdp()` changeset). Local development (`npm run dev`) always serves the stub. If the same backend module is also deployed, choose the provider by environment.
