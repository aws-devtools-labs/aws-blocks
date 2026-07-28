---
"@aws-blocks/auth-common": patch
"@aws-blocks/blocks": patch
---

Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers the container, heading, error, per-action wrappers, every field input, submit buttons, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. The full selector contract is documented in CUSTOMIZING-AUTH-UI.md.

The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these components from `@aws-blocks/auth-common/ui`. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the components it hands to consumers.
