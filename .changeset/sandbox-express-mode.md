---
"@aws-blocks/core": patch
---

Speed up sandbox deploys with CloudFormation **Express Mode**: `npm run sandbox` now runs `cdk deploy --method direct --express`. Express Mode reports each stack operation complete as soon as the resource's configuration is applied, without waiting for full stabilization — a substantial speedup for the sandbox iteration loop.

This is sandbox-only. The production deploy (`npm run deploy`) is unchanged — it keeps a reviewable CloudFormation change set and full stabilization with automatic rollback. Express Mode disables automatic rollback by default; we keep that default for the throwaway sandbox loop rather than forcing `--rollback`, so a failed sandbox deploy may leave the stack in a failed state until the next deploy.

Requires an `aws-cdk` CLI that supports `--express`, so the CLI dev-dependency floor is bumped to `^2.1138.0`.

The sandbox deploy argv is built by the pure, unit-tested `buildSandboxDeployArgs` helper (mirroring the existing `buildCdkDeployArgs` for production).
