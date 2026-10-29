---
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": minor
---

The local user pool can check authenticator-app (TOTP) codes as Cognito does. With the new local-only option `totpVerification: 'rfc6238'`, `verifyTotpSetup`, the sign-in TOTP challenge and the mid-sign-in TOTP setup accept only the RFC 6238 code of the user's shared secret (HMAC-SHA-1, 6 digits, 30-second steps, one step of clock skew), so a wrong secret or `otpauth://` URI fails locally instead of only on a deployed pool. The default, `'any'`, still accepts any six digits; the AWS runtime ignores the option. An unknown value is an error at construction. As on Cognito, a new `setUpTotp` secret replaces an enrolled authenticator only once `verifyTotpSetup` accepts it, so an abandoned replacement keeps the working one.

`totpCodeFor(sharedSecret, time?)` from `@aws-blocks/blocks/utils` (also `@aws-blocks/bb-auth/testing`) computes the code an authenticator app would show, so tests answer TOTP setup and challenges without a phone (Node.js only, `node:crypto`, no new dependency). Like the rest of `@aws-blocks/blocks/utils` it has no browser build: Node test suites that run with the browser condition (`tsx -C browser`) still get it, and the browser entries never import it.
