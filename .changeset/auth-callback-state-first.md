---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

A federated sign-in callback checks `state` before it shows an error. Error callbacks (`error`, `error_description`) are honoured only when they carry the `state` of the sign-in in progress, so a crafted link to `/aws-blocks/auth/callback` can't make your app answer with an error name, status or message of an attacker's choosing while a user signs in with a social, SAML or OIDC provider. Anything else gets the same `InvalidStateException` as a forged success callback. Genuine provider errors, including `validateUser` rejections on a first federated sign-in, are reported to the user.
