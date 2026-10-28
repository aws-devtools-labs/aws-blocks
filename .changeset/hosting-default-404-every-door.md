---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
---

fix(hosting): serve the default 404 page behind every front door

A multi-page static site that ships no 404 page of its own and sets no
`errorPages.notFound` (for example Astro with `output: 'static'` and no
`404.astro`) now gets AWS Blocks' default "404 — Page Not Found" page, at HTTP
404, behind every front door, not only CloudFront. The ALB and API Gateway
(HTTP and REST) doors serve it from their asset proxy instead of a plain-text
`Not Found`. A bring-your-own door receives it as `DoorInput.app.errorPages.notFound`
(`_not_found.html`), so `cf.errorPages` wires it too. The precedence is the same
on every door: the app's `errorPages.notFound`, then the framework's
`errorPages[404]`, then the default. The stacked door's edge and
`cf.errorPages` now serve an error page at its own key (the default
`_not_found.html`, or a framework page under any name) instead of always
pointing at `404.html` / `500.html`. An SPA keeps its `index.html` fallback, a
site with a server keeps its own 404, and the `'none'` door keeps its S3
website error document.

Every door now makes the same decision from the manifest:
- only an explicit `staticAssets.spaFallback: true` is an SPA, as in routing,
  so a custom adapter's manifest that leaves it unset gets the default page
  rather than S3's 403 (the built-in adapters always set it);
- an image optimizer doesn't count as a server, so a static site with one
  still gets the default page on CloudFront too;
- the build's cutover waits for the default page's upload, so a miss never
  reaches a new build before its 404 page does.

The CloudFront door no longer maps 403 twice for a static site that ships a
500 page but no 404 page. `cf.origin` now lets CloudFront list the assets
bucket (scoped to the door's distribution, as on the built-in doors), so a
missing file is a 404 and a bring-your-own door's `cf.errorPages` can serve
the page. The CloudFront template of an app built by a built-in adapter is
otherwise unchanged.

The docs now match the doors' behavior:
- the ALB door's own alarms are on unless `monitoring: { enabled: false }`;
- only a CloudFront-backed door takes over the API's address under
  `apiFrontDoor: 'cloudfront'`;
- the ALB packs listener rules within five condition values and six wildcards
  per rule;
- which servers behind the ALB and API Gateway doors are given `Host` as
  `x-forwarded-host`, and which receive the client's value.
