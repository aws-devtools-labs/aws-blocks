---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-agent": minor
"@aws-blocks/bb-app-setting": minor
"@aws-blocks/bb-async-job": minor
"@aws-blocks/bb-auth": minor
"@aws-blocks/bb-compute": minor
"@aws-blocks/bb-container-compute": minor
"@aws-blocks/bb-cron-job": minor
"@aws-blocks/bb-dashboard": minor
"@aws-blocks/bb-data": minor
"@aws-blocks/bb-distributed-data": minor
"@aws-blocks/bb-distributed-table": minor
"@aws-blocks/bb-email-client": minor
"@aws-blocks/bb-file-bucket": minor
"@aws-blocks/bb-knowledge-base": minor
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/bb-lambda-compute": minor
"@aws-blocks/bb-logger": minor
"@aws-blocks/bb-metrics": minor
"@aws-blocks/bb-realtime": minor
"@aws-blocks/bb-secret": minor
"@aws-blocks/bb-tracer": minor
"@aws-blocks/hosting": patch
"@aws-blocks/create-block": minor
---

feat: Building Block mock entries fail closed in a deployed environment

- **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
- **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
- **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the `Auth` IdP-registration and immutability-guard and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
- **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
- **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.
