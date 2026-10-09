---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(hosting): the image-optimization Lambda's SVG gate now decides by content, not file extension

With `dangerouslyAllowSVG` / `IMAGE_ALLOW_SVG` off, the image Lambda rejected SVG
sources only when the URL ended in `.svg`. An origin's content type isn't tied to its
path, so an SVG served from `/logo` or `/logo.png` passed the gate and was returned as
`image/svg+xml` from the application's own origin. SVGO, which IPX runs on SVG input,
is an optimiser rather than a sanitiser and keeps some script-capable constructs.

The Lambda now sniffs the image bytes from both the S3 originals bucket and allowlisted
remote hosts, and rejects SVG content with a `415` before IPX processes it. That also
covers rasterizing requests such as `?f=png`. As a backstop it refuses any SVG output
unless SVG is enabled. The `.svg` extension check remains as a cheap pre-filter.
Nothing changes when SVG is enabled, or for raster images.
