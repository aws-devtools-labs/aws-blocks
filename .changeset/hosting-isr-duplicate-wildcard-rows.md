---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(hosting): pages that render on demand inside a Nuxt/Nitro ISR folder no longer 404

With an ISR or SWR route rule that names a folder in `public/` (for example `routeRules: { '/blog/**': { isr: 60 }, '/blog/featured': { prerender: true } }`), the Nitro adapter used to emit a blanket static `/blog/*` route for the folder. Every front door takes the first match, so `/blog/any-other-post` went to the static asset origin and returned 404, including when the prerendered page sat one folder deeper (`/blog/2024/featured`).

The folder no longer gets a blanket static route. Instead:

- Its real files keep their own static routes: each file directly in the folder (`/blog/hero.png`), and one route per sub-folder that holds no pages (`/blog/img/*`). They're still served from S3.
- A page frozen by an explicit `prerender: true` rule keeps its own routes and is still served frozen from S3.
- Every other path under the folder goes to the server and renders on demand.

`RouteBehavior` has a new optional `exact` field. A route marked `exact` keeps its own row in the front door's route table: it isn't merged with its siblings into a `<parent>/*` wildcard, and it isn't switched to the server when ISR/SWR is active. The Nitro adapter sets it for the routes above. A site-wide rule (`'/**'`) and apps without ISR/SWR rules are unchanged.
