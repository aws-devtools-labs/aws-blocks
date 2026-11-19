---
'@aws-cdk-blocks/hosting': patch
'@aws-cdk-blocks/core': patch
---

Docs and one error message now match what `Hosting` does:

- On the CloudFront door, `waf: { enabled: true }` needs a stack in us-east-1, because AWS WAF creates CLOUDFRONT-scoped web ACLs only there. From another region, create the web ACL in a us-east-1 stack and pass its ARN as `waf: { enabled: true, webAclArn }`. The README's settings table and front-door section say so, and `WafRegionError`'s resolution names that option.
- The `'none'` door needs S3 Block Public Access to allow public bucket policies, at the account level and on the bucket. Without that, the deploy fails at the bucket policy.
- Next.js middleware runs inside the server function unless a hand-written `open-next.config.ts` sets `middleware: { external: true }`. Only in that case does a door other than CloudFront fail synth with `MiddlewareNeedsCloudFrontDoorError`. Behind the API Gateway HTTP API door, middleware runs.
- The core README and the `framework` JSDoc list every framework type and the auto-detection order. `nitro`, `astro` and `sveltekit` were missing, and so was `'spa'` as the type used when there is no `package.json`.
