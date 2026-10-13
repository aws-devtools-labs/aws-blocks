---
"@aws-blocks/core": minor
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/bb-auth-cognito": minor
"@aws-blocks/blocks": minor
---

Add a runtime guard that fails closed when auth Building Block mocks are loaded in a deployed environment, and remove the hardcoded OIDC mock cookie secret.

`@aws-blocks/core` adds `assertNotDeployedMock(bbName)` (exported from `@aws-blocks/core/bb-utils`), which throws when a mock entry runs inside a deployed Lambda (detected via `AWS_LAMBDA_FUNCTION_NAME` / `AWS_EXECUTION_ENV`). This closes the gap left by the CDK-only `assertCdkConditionActive`: if a backend is bundled without the `aws-runtime` export condition, module resolution silently falls back to each BB's `default` (mock) entry, and previously a deployed function would have run in-memory auth stubs. The OIDC and Cognito auth mocks now call this guard in their constructor, so a mis-bundled deploy fails fast at startup instead of accepting stub/forged sessions. The guard is a no-op locally (`npm run dev`, tests), so local development is unaffected.

The OIDC mock's cookie-signing secret is no longer a constant shipped on npm — it is now generated per process with `crypto.randomBytes(32)` at module load. Sign and verify happen within the same local process, so the mock's cookie round-trip is unaffected.

Note for maintainers: on `0.x` packages this ships as a `minor` per this repo's convention (minor is the breaking/behavior-change channel pre-1.0), since the auth mocks now throw in deployed environments. `@aws-blocks/blocks` is bumped because it re-exports `@aws-blocks/core` and the auth packages.
