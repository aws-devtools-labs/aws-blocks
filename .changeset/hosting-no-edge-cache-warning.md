---
'@aws-cdk-blocks/hosting': patch
'@aws-cdk-blocks/core': patch
---

Behind the ALB and API Gateway front doors, which have no edge cache, synth now warns once per app (`@aws-cdk-blocks/hosting:NoEdgeCache`) when the app's header rules set a shared-cache `Cache-Control` (`s-maxage`, `stale-while-revalidate` or `stale-if-error`; the Nitro adapter emits these for `swr` and `cache.maxAge` route rules). The warning names the routes (the first five, then a count) and points to the CloudFront and stacked doors, which cache at the edge. On these doors such routes reach the server on every request and the header goes to the browser unchanged. The READMEs now say what caching still happens there per framework (Nitro's server-side cache, Next.js ISR through OpenNext's incremental cache, none for Astro and SvelteKit), and that moving an app from the CloudFront door to one of these doors loses the edge cache.
