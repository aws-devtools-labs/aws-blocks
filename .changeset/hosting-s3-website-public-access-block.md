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
