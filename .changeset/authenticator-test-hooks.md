---
"@aws-blocks/auth-common": patch
---

Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers the container, heading, error, per-action wrappers, every field input, submit buttons, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. The full selector contract is documented in CUSTOMIZING-AUTH-UI.md.
