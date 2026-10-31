---
"@aws-blocks/core": patch
---

fix(core): production destroy and deploy guidance for the `blocks` CLI

- The production `destroy()` loads `.env.production` and sets `BLOCKS_STAGE=production`, as `deploy()` does, so it deletes with the credentials and Region the deploy used. Before, an `AWS_PROFILE` or `AWS_REGION` set only in `.env.production` was ignored, and the destroy targeted the default profile or another Region.
- The production `destroy()` takes an optional `stackName`. When CloudFormation has no stack of that name in the target Region, it prints `There is no stack <name> in Region <region>; nothing to delete.` and runs no `cdk destroy`, which reported a missing stack as `✅ Production stack destroyed!`.
