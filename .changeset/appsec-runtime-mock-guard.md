---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-agent": minor
"@aws-blocks/bb-app-setting": minor
"@aws-blocks/bb-async-job": minor
"@aws-blocks/bb-auth-cognito": minor
"@aws-blocks/bb-auth-oidc": minor
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
---

feat: Building Block mock entries fail closed in a deployed environment

- **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it configures, so the check covers Lambda, container, AgentCore, and other compute targets alike. It is a no-op in local dev and tests.
- **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws at startup instead of running in-memory stubs.
- **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now a random per-process value instead of a fixed string. Local sign-in is unchanged; sessions no longer survive a dev-server restart.
- **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition.
- **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own.

Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.
