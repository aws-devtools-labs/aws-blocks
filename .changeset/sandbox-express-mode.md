---
"@aws-blocks/core": patch
---

Speed up sandbox deploys with CDK "express mode": `npm run sandbox` now runs `cdk deploy` with `--method direct`, which skips CloudFormation change-set creation and calls `UpdateStack` directly. This trims a couple of change-set round-trips off every sandbox iteration while remaining a full CloudFormation deploy (all resource types — unlike `--hotswap`).

This applies to the sandbox path only. The production deploy (`npm run deploy`) is unchanged and still goes through a reviewable change set, since a direct `UpdateStack` has no change set to inspect.

The sandbox deploy argv is now built by the pure, unit-tested `buildSandboxDeployArgs` helper (mirroring the existing `buildCdkDeployArgs` for production).
