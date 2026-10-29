---
"@aws-blocks/bb-auth-oidc": patch
---

refactor: use Node's built-in `base64url` encoding for signed state and session cookies

The hand-written base64url helpers are replaced with `Buffer`'s native `base64url` encoding. The encoded output is unchanged, so existing cookies and in-flight sign-in state stay valid.
