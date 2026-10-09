---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` warns at synth when a block's first baseline records no user pool of its own (a configuration without a pool-backed sign-in method, or `userPool: Auth.fromExisting(…)`). An app moving from `AuthCognito` has no baseline yet, so its first `Auth` synth can't refuse a configuration that drops the pool. If the stack already had a pool for that block, the deploy deletes it and every user in it, unless the pool was already deployed with `removalPolicy: 'retain'`. The warning (`@aws-blocks/bb-auth:FirstBaselineWithoutPool`) says so and points to `MIGRATION.md`.

`MIGRATION.md` starts its checklist with the safe order. First deploy the codemod's output unchanged and commit the baseline it writes. Change the configuration only after that, because from then on synth refuses a change that would remove the pool. For `preferredChallenge: 'EMAIL_OTP'`, the guide and the codemod's TODO and summary warn against wrapping the block's own pool with `Auth.fromExisting`, which deletes it. `DESIGN.md` explains what the deploy-time guard does not cover, and recommends committing baselines from your deploy workflow.
