---
"@aws-blocks/bb-auth-oidc": patch
---

Reject stub IdP redirect_uris whose query carries a reserved OAuth/OIDC response param, matching real-IdP behavior.
