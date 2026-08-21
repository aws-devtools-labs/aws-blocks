---
"@aws-blocks/bb-auth-oidc": patch
---

Reject stub IdP redirect_uris whose query carries a reserved OAuth/OIDC response param, or that carry a URI fragment, matching real-IdP behavior. Reserved-param matching is case-sensitive, so a distinctly-cased key such as `State` is passed through as a real IdP would.
