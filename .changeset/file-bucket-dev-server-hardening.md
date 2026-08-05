---
"@aws-blocks/bb-file-bucket": patch
---

Harden the local dev file server against stored XSS and token forgery. Downloads are now served with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, so an uploaded `text/html`/SVG payload can no longer execute inline in the app's origin. The HMAC secret used to sign presigned-URL tokens is now a per-process random value instead of a hardcoded, source-visible literal, so tokens can no longer be forged offline. Both the token-minting mock and the validating dev file server share the same in-process value, so local presigned-URL round-trips are unaffected.
