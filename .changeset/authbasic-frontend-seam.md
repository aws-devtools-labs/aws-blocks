---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

docs(bb-auth-basic): add the frontend login-UI mount + gate seam

The Quick Start documented the backend (`createApi()`, `requireAuth`) but not
the frontend half, so builders and agents provisioned `AuthBasic` and assumed a
login UI would appear — nothing rendered, leaving every authenticated route
unreachable. The README now shows the end-to-end seam: import
`Authenticator` / `AuthenticatedContent` from `@aws-blocks/blocks/ui`, mount the
login UI in the SPA entrypoint, and gate the app shell behind an authenticated
session, with a pointer to the already-shipped testid contract
(`authenticator-<field>` / `authenticator-action-<action>`) in
`auth-common/CUSTOMIZING-AUTH-UI.md`.

Documentation only — no runtime or API change.
