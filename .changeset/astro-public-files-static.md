---
'@aws-cdk-blocks/hosting': patch
---

Astro server builds now route the files copied from `public/` (such as `robots.txt`, favicons and downloads) to the assets bucket, like Nuxt and SvelteKit builds already do. Every front door serves them as static files instead of sending them to the Astro server, so the stacked door's CloudFront edge caches them and a file over 1 MB no longer fails behind the ALB router. A `public/` folder is routed as a whole only when no page can render under it; otherwise it stays with the server.
