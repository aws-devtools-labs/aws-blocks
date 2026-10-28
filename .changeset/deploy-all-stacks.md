---
"@aws-blocks/core": patch
---

fix(core): deploy every stack with `npm run deploy`

`npm run deploy` now passes `--all` to `cdk deploy`. Apps that synthesize more than one stack — `Hosting` with an explicit `env.region` other than `us-east-1` (which adds a `us-east-1` CloudFront-alarm monitoring stack), or any Lambda@Edge function such as a Next.js `runtime = 'edge'` route (which adds the CDK edge-support stack in `us-east-1`) — previously failed before any stack was deployed, because the CDK CLI refuses a multi-stack app without a stack selector. This matches `npm run sandbox`, which already passes `--all`.
