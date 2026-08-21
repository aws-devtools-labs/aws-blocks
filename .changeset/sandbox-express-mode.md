---
"@aws-blocks/core": patch
---

Speed up sandbox deploys with CloudFormation **Express Mode**: `npm run sandbox` now runs `cdk deploy --method direct --express`. Express Mode reports each stack operation complete as soon as the resource's configuration is applied, without waiting for full stabilization — a substantial speedup for the sandbox iteration loop.

This is sandbox-only. The production deploy (`npm run deploy`) is unchanged — it keeps a reviewable CloudFormation change set and full stabilization with automatic rollback. Express Mode disables automatic rollback by default; we keep that default for the throwaway sandbox loop rather than forcing `--rollback`, so a failed sandbox deploy may leave the stack in a failed state until the next deploy.

Observability trade-off: `--method direct` also drops some of the CDK CLI's per-resource progress output (it has no change set to report against), and Express Mode itself returns before resources finish stabilizing. Expect less granular deploy progress for sandbox deploys than the production path emits. Because the deploy returns before stabilization, a resource that is still propagating (e.g. a CloudFront distribution) may not be fully ready on the very first request right after `npm run sandbox` returns; this is an accepted trade for sandbox iteration speed.

Requires an `aws-cdk` CLI new enough to expose `--express`. The CLI dev-dependency floor is bumped to `^2.1138.0`, a version that has the flag (it is not necessarily the version that introduced it).

The sandbox deploy argv is built by the pure, unit-tested `buildSandboxDeployArgs` helper (mirroring the existing `buildCdkDeployArgs` for production).
