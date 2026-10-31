---
"@aws-blocks/core": patch
---

fix(core): production destroy and deploy guidance for the `blocks` CLI

- The production `destroy()` loads `.env.production` and sets `BLOCKS_STAGE=production`, as `deploy()` does, so it deletes with the credentials and Region the deploy used. Before, an `AWS_PROFILE` or `AWS_REGION` set only in `.env.production` was ignored, and the destroy targeted the default profile or another Region.
