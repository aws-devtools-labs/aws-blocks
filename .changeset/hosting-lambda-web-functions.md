---
'@aws-blocks/hosting': minor
'@aws-blocks/core': minor
'@aws-blocks/blocks': minor
---

Add `compute.type: 'web-function'` to run the SSR server on AWS Lambda Web Functions. The framework's own Node.js server runs directly on Lambda behind CloudFront origin access control, with no API Gateway and no Lambda Web Adapter. Each execution environment serves many concurrent requests and is billed for active CPU. It works with Astro, SvelteKit, Nuxt/Nitro and Next.js in the Regions where Web Functions are available. When this compute is selected, Nitro builds with the `node-server` preset and Next.js builds with OpenNext's `node` wrapper automatically. Tune it with `compute.webFunction` (`maxConcurrencyPerEnvironment`, `maxEnvironments`, `rateLimit`). The default (`'lambda'`) is unchanged.

Sandbox deploys (`npm run sandbox`) of a Web Function app skip CloudFormation Express Mode after the first deploy. Express Mode can't update a Web Function endpoint, so the deploy uses a full deploy with rollback instead.
