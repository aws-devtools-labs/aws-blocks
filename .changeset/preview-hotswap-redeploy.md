---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

Speed up **preview-mode re-deploys** with CDK hotswap. When a hosting preview stack already exists (a prior deploy wrote `outputs.json`), `startSandbox` now re-deploys with `cdk deploy --hotswap-fallback --express`: a code-only change is applied directly to the Lambdas (and static-asset S3 sync) in seconds instead of a full CloudFormation deploy.

- **Scoped to preview mode only.** Hotswap deliberately introduces CloudFormation drift, so a plain backend-only sandbox and every production deploy keep the drift-free CloudFormation path. The first preview deploy (no `outputs.json` yet) also uses the full path.
- **Fast fallback.** `--hotswap-fallback` and `--express` are orthogonal — one decides *whether* to touch CloudFormation, the other *how* the CloudFormation deploy runs — so when a non-hotswappable change forces the fallback, it still runs in the fast Express Mode rather than a plain slow deploy.
- **Stable preview buildId.** Preview mode now pins the manifest `buildId` to `'preview'` (overwrite-in-place) instead of a per-deploy random id. The random id drives production's atomic `builds/<id>/` cutover (zero-downtime), but it bakes into the asset prefix, the SSR Lambda code key, the `BucketDeployment` prefix, and the bypass API name — churning all of them every deploy, which is non-hotswappable and forced hotswap to fall back every time. A preview is a single throwaway environment with no zero-downtime requirement, so a fixed id is correct and lets a code-only change stay a true (seconds) hotswap. Production is unchanged — it keeps the per-deploy atomic buildId.

Note: a true hotswap requires a deterministic synth. Any stack tag/env/name whose value changes per-synth — a date stamp, git sha, timestamp, or a per-deploy build id — is not hotswappable and forces the Express fallback. Keep preview-stack tags deterministic to get the seconds-fast path.
