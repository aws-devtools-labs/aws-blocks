---
'@aws-blocks/hosting': minor
'@aws-blocks/core': minor
'@aws-blocks/blocks': minor
---

Add `compute.type: 'web-function'` to run the SSR server on AWS Lambda Web Functions. The framework's own Node.js server runs directly on Lambda behind CloudFront origin access control, with no API Gateway and no Lambda Web Adapter. Each execution environment serves many concurrent requests and is billed for active CPU. It supports HTTP-server builds (Astro, SvelteKit, Nuxt/Nitro `node-server`, OpenNext `docker` origins) in the Regions where Web Functions are available. Tune it with `compute.webFunction` (`maxConcurrencyPerEnvironment`, `maxEnvironments`, `rateLimit`). The default (`'lambda'`) is unchanged.
