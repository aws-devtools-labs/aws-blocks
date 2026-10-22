---
"@aws-blocks/hosting": minor
"@aws-blocks/core": patch
---

perf(hosting,core): faster preview deploys

- `HostingConstruct` takes `inPlaceBuild`: each deploy overwrites the build under the same `builds/<buildId>/` prefix, so the ALB and API Gateway asset proxies (the door's `cutover`) are not ordered after the asset uploads and the runtime config upload. CloudFormation creates them alongside the uploads. The CloudFront door ignores it. `Hosting` sets it for `buildId: 'fixed'` (`HostingPresets.preview`).
- A preview re-deploy (`startSandbox({ preview: true })`) passes `--method direct` next to `--hotswap-fallback`, so a change that can't be hotswapped falls back to a direct CloudFormation update instead of creating and executing a change set.
