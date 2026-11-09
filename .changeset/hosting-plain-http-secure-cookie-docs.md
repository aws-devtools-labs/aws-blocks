---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

docs(hosting): explain what a plain-HTTP front door does to session cookies

The README's front-door section now says that behind a standalone ALB door with no certificate, `AuthBasic` omits `Secure` from its same-origin session cookie (a browser discards a `Secure` cookie from a plain-HTTP origin), so the cookie and the session travel in clear text, while `AuthCognito` and `AuthOIDC` keep `Secure` and their sign-in doesn't persist. It recommends a certificate (an HTTPS listener) for anything beyond testing, and points at the separate `StackedRouterPlainHttp` warning for the stacked door's edge → router hop.
