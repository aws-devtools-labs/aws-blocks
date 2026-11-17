---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

`signIn`, `confirmSignIn` and `autoSignIn` check each step against the block's options at runtime, as `SignInNextStep<O>` does at compile time. A step the options do not enable means the user pool was configured outside the block (the console, another stack, a deploy half-way): the call fails with `InternalErrorException` naming the step, and the server log lists the step and the configured ones, rather than returning a step the caller's narrowed type says cannot happen. A pool wrapped with `Auth.fromExisting` passes every step.

In `npm run dev`, the local pool offers only the factors `mfa.types` lists, even to a user who enrolled in one while it was listed, as Cognito does.

Native clients get every sign-in step, every MFA factor in `getMfaPreference` / `updateMfaPreference`, and each block's own user schema, whatever the options.
