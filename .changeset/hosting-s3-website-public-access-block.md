---
"@aws-blocks/hosting": patch
---

fix(hosting): the `frontDoor: 'none'` (S3 website) door served **403 Forbidden** — public reads were silently blocked

The S3-website door set a public-read bucket policy but configured the bucket's
Public Access Block with the **deprecated** `BlockPublicAccess.BLOCK_ACLS`, which
only sets `blockPublicAcls`/`ignorePublicAcls` and leaves `blockPublicPolicy` and
`restrictPublicBuckets` **unset** — so S3 defaults them to `true` and **neutralizes
the public-read policy**. Every anonymous request to the website endpoint then got
`403 Forbidden` (the SPA never loaded).

Switched to `BlockPublicAccess.BLOCK_ACLS_ONLY`, which explicitly sets
`blockPublicPolicy: false` and `restrictPublicBuckets: false` (still blocking ACLs),
so the public-read policy takes effect and the site is reachable. Verified live: a
redeployed `'none'` app now serves `/` and `/assets/*` with `200`.

Two further `'none'`-door correctness fixes in the same construct:

- **SPA deep-links 403 → now fall through to the error document.** The website
  bucket granted `s3:GetObject` but not `s3:ListBucket`, so S3 returned `403`
  (AccessDenied) for a missing key and served its OWN 403 page instead of the
  `index.html` error document — breaking client-side deep links (e.g. `/auth`).
  Added a public `s3:ListBucket` statement so a missing key is a `404` (NoSuchKey)
  that S3 routes to the error document. (Trade-off: the object list is publicly
  enumerable — inherent to raw-S3-website SPA fallback without a CDN.)
- **`config.json` placeholder clobbered the real config → cross-origin `apiUrl`
  lost.** The build ships a placeholder `.blocks-sandbox/config.json`
  (`{_placeholder:true}`); the real config (with the absolute cross-origin
  `apiUrl` the `'none'` door needs) is written to the same key by the separate
  `BlocksConfigDeployment`. The website deployment uploaded the placeholder and
  pruned, racing/clobbering the real config, so the SPA got no `apiUrl` and fell
  back to a relative `/aws-blocks/api` (which the S3 website `405`s). The website
  deployment now `exclude`s `.blocks-sandbox/*` and no longer prunes, so the config
  deployment deterministically owns that key.

Note: on accounts with an S3 **Block Public Access guardrail** (e.g. an org/Config
auto-remediation that re-enables it), the `'none'` door — being a *public* bucket —
cannot be served regardless of these fixes; use a private-bucket door
(`'cloudfront'` / `alb` / `apiGateway`) there. `'none'` remains a cheapest-static,
permissive-account / dev door (and its cross-origin cookie auth is unsupported over
HTTP by design).
