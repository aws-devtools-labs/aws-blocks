---
"@aws-blocks/core": patch
"@aws-blocks/create-blocks-app": patch
---

A stack name that starts with `aws` in any letter case is now an error at synth, for `BlocksStack` and for a `BlocksBackend` inside such a stack. The message names the stack, the two AWS Resource Groups that AWS Blocks names after it, and the fix: use a name that does not start with `aws`; in a scaffolded app, change `stackId` in `.blocks/config.json`. Before, `cdk deploy` failed in CloudFormation with `Group name must not start with 'AWS'` after other resources were created. `cdk synth`, `cdk diff` and `cdk deploy` stop on the error. `cdk destroy` and `cdk ls` do not, so a stack that such a deploy left behind can still be removed. A `stackId` written by hand is never changed.

The `AGENTS.md` that `create-blocks-app` adds to new apps states the rule.
