---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

A failed federated sign-in never shows the identity provider's own error text to the user.

When a social, SAML or OIDC provider sends your app back to `/aws-blocks/auth/callback` with an error, the provider's `error` and `error_description` are written by the provider (or by Cognito managed login), and they can quote the request, echo the user's login or name an internal endpoint. So the `IdpErrorException` message — the string the `<Authenticator>` renders — is one fixed message, `The identity provider '<id>' refused the sign-in.`, and the provider's text goes to the server log instead: at `info` for an ordinary refusal such as `access_denied`, and at `error` when the provider reports a fault or its text names AWS resources. The error `name` is `IdpErrorException`, so code matching errors with `isAuthError` works as usual.

The native / CLI relay is the deliberate exception: there the callback is an OAuth redirect handed back to the app that started the sign-in, so `error` and `error_description` are forwarded to it as the OAuth spec defines, and nothing is rendered to a browser. Server log lines that carry an error message redact the user's login in every case, including errors `Auth` reports as an internal error.
