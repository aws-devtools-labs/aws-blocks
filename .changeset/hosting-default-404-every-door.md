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
`errorPages[404]`, then the default. An SPA keeps its `index.html` fallback, a
site with a server keeps its own 404, and the `'none'` door keeps its S3
website error document. The CloudFront door's template is unchanged.

The docs now match the doors' behavior:
- the ALB door's own alarms are on unless `monitoring: { enabled: false }`;
- only a CloudFront-backed door takes over the API's address under
  `apiFrontDoor: 'cloudfront'`;
- the ALB packs listener rules within five condition values and six wildcards
  per rule;
- which servers behind the ALB and API Gateway doors are given `Host` as
  `x-forwarded-host`, and which receive the client's value.
