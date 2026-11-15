---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

feat(bb-auth): the stub IdP has an end-session endpoint that redirects only to registered URIs

The `stubIdp()` provider serves an OIDC end-session endpoint (`/aws-blocks/auth/idp/<id>/logout`), so signing out of a stub session walks the same redirect chain as a real identity provider. Like a real one, it redirects only to a registered `post_logout_redirect_uri`: your app's origin plus `redirects.postSignOutPath` or `redirects.signOutPath`, matched exactly, so a link to it can't send a browser to another site. Any other URI, or an unknown `client_id`, gets a `400` error and no redirect. A request without a `post_logout_redirect_uri` shows a signed-out page. Sign-out through `Auth` always sends a registered URI.
