---
'@aws-cdk-blocks/hosting': patch
---

Nuxt / Nitro `redirect` route rules with a `/**` destination now redirect to the same URL Nitro does: `'/blog/**': { redirect: '/posts/**' }` sends `/blog/a/b` to `/posts/a/b` (it sent `/posts/*a/b`) on every front door. A rule without a status now defaults to 307, as in Nitro, and a rule the door can't reproduce (a destination ending in a single `*`) is left to the Nitro server.
