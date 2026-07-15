---
"@aws-blocks/create-blocks-app": patch
---

Env-gate the `getLastCode` OTP helper in the `auth-cognito` template so a verification code can never be captured, logged, or returned from a deployed environment.

The passwordless-OTP demo exposes `api.getLastCode()` (tagged `@blocksSkipCodegen`) so the local UI can read the emailed code without a real mailbox. Its behavior was documented as "no-op in Sandbox/Production" but nothing enforced it — the `codeDelivery` hook captured the code and the method returned it unconditionally, so a live OTP could leak in a deployed environment. Both the capture and the read are now gated behind `isLocalDev()` (added as `aws-blocks/is-local-dev.ts`), which keys off `BLOCKS_STACK_NAME` — the marker BlocksBackend injects into every deployed Blocks Lambda and leaves unset in local/mock dev, matching how the framework's generated DB connection resolver distinguishes deployed vs. local. A unit test (`aws-blocks/is-local-dev.test.ts`) covers both branches: the code is returned in local/mock dev and `null` in a deployed environment.
