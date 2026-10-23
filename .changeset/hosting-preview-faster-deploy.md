---
"@aws-blocks/hosting": minor
"@aws-blocks/core": patch
---

perf(hosting,core): faster preview deploys

- `HostingConstruct` takes `inPlaceBuild`: each deploy overwrites the build under the same `builds/<buildId>/` prefix, so the ALB and API Gateway asset proxies (the door's `cutover`) are not ordered after the asset uploads and the runtime config upload. CloudFormation creates them alongside the uploads. The CloudFront door ignores it. `Hosting` sets it for `buildId: 'fixed'` (`HostingPresets.preview`).
- A preview re-deploy (`startSandbox({ preview: true })`) passes `--method direct` next to `--hotswap-fallback`, so a change that can't be hotswapped falls back to a direct CloudFormation update instead of creating and executing a change set.
- A Next.js build with `imageOptimization: false` (`HostingPresets.preview`) no longer installs `sharp`. The generated `open-next.config.ts` sets `imageOptimization: { install: false }`, so OpenNext skips its `sharp` install for the image-optimization bundle that is never deployed. Builds that deploy the image-optimization function are unchanged.
- An in-place build (`inPlaceBuild`, `buildId: 'fixed'`) drops the AWS CLI layers no upload handler uses. Every CDK `BucketDeployment` creates its own layer, but the stack's shared upload handler uses only one per memory size; the others were published on every create, and the one under the runtime config upload was the last resource the stack waited for. Default and production builds keep every layer.
