---
"@aws-blocks/hosting": patch
---

fix(hosting): serve HTML from the current build after a deploy (fixes returning-visitor blank page)

Returning visitors — browsers holding a `__dpl` skew-protection cookie from a
previous build — got a blank page on their first load after every deploy (a
second reload fixed it). The KVS router's viewer-request function honored the
`__dpl` cookie for **all** URIs including HTML, so a returning visitor was served
the **old** build's HTML, while the viewer-response function stamped `__dpl` with
the **current** build on every HTML response. The old HTML references
content-hashed assets that only exist under the old build's prefix; with the
cookie now advanced to the new build, those asset requests were rewritten to
`/builds/<newBuildId>/…<oldHash>` (which does not exist) and failed (403 on
0.1.4, 404 on ≥ 0.1.5), rendering a blank page.

The viewer-request function now resolves HTML documents from the current build
(`meta.b`), never a pinned cookie build, while assets keep honoring the cookie.
HTML, cookie, and referenced assets therefore always agree on one build
generation. Mid-session visitors stay safe: asset requests keep honoring their
old cookie and old `builds/<id>/` prefixes are retained (`prune: false`), so an
already-loaded page keeps working until the next HTML navigation lands the
visitor consistently on the current build.
