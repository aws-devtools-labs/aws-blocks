---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Only the `Auth` block that owns a user pool's PreSignUp trigger answers it. So when one `Auth` creates a pool with `validateUser` and another wraps that pool with `userPool: Auth.fromExisting(…)` (for example, to use `admin`), the second block can't take over the trigger, and `validateUser` still runs for sign-ups made directly against Cognito.

Two `Auth` blocks claiming one user pool's PreSignUp trigger fail `cdk synth`, naming the event key and both blocks, like other Building Blocks that would handle the same Lambda event.
