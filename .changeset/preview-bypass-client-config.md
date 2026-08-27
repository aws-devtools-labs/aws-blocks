---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
---

Fix browser-side API-URL resolution under `bypassCdn` (interactive auth was
broken even though the HTTP route worked).

Three fixes, found via a real browser (Playwright) walk of a Nuxt bypass deploy:

- **Client same-origin default (core):** in the browser, when no `apiUrl` is
  resolved from config, default to the same-origin RPC prefix `/aws-blocks/api`
  instead of throwing. Blocks always mounts the API same-origin (CloudFront and
  the bypass single origin both proxy it), so a relative URL resolves — keeping
  interactive auth working even if `config.json` is missing or a placeholder.
  Only reached after the config.json fetch yields nothing, so a deployed
  cross-domain `apiUrl` still wins.
- **Bypass config not clobbered (hosting):** `BypassAssets` now excludes the
  build-time placeholder `.blocks-sandbox/config.json` so only the real runtime
  config (with the same-origin `apiUrl`) writes that key — order-independent.
- **Robust config-deployment ordering (core):** the dependency that makes the
  config deployment run AFTER the asset uploads now matches `BucketDeployment`
  by `instanceof` OR constructor name, so a duplicate/linked `aws-cdk-lib`
  (common with file:-linked framework packages) can't silently drop the
  dependency and let a placeholder win.

Validated end-to-end in a browser against a Nuxt `bypassCdn` deploy: sign-up →
verify → sign-in (same-origin cookie set), authed dashboard/profile, create +
list + delete posts (auth-protected), SSR home reflects the new post, non-GET
framework routes (`POST /api/probe/echo`) return 200 with the body intact, and
sign-out clears the session (protected endpoint then returns "Authentication
required"). The SSR Lambda remains private (no Function URL).
