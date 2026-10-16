---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

fix(bb-auth): the stub IdP accepts only its registered client and redirect URIs

The `stubIdp()` provider's authorize endpoint (`/aws-blocks/auth/idp/<id>/authorize`) checks every sign-in request the way a real identity provider does. It accepts only the stub's own `client_id` and a registered `redirect_uri`: your app's sign-in callback (`redirects.callbackPath`) on your app's origin, or on the API Gateway URL when the stub is deployed. So a crafted link can't send a browser, with a sign-in code, to another site. Any other `client_id` or `redirect_uri` gets a `400` error page and no redirect, before the account picker shows or `onAuthorize` runs. Sign-in through `Auth` and the Kotlin, Swift and Dart SDKs sends the registered callback, so it works unchanged.

A stack that deploys a stub with `unsafeAllowDeployed: true` fails synth with a clear error when the block's compute has no API URL, because the deployed stub builds its issuer from that URL.
