---
'@aws-blocks/core': minor
'@aws-blocks/blocks': patch
---

Record every deploy in `.blocks/deploy-history.jsonl`. A deploy appends one `IN_PROGRESS` record when it starts and one terminal record with the same id when it ends, so a reader merges by id with last-record-wins and a dangling `IN_PROGRESS` record means the process died mid-deploy. The region and stack name are captured at deploy time rather than resolved when the file is read, because ambient `AWS_REGION` and IMDS can point somewhere other than where the deploy actually went.

Writing is best-effort: a history file that cannot be written never fails the deploy it describes. The sandbox path records the explicit deploy only, since a later `cdk watch` hot-swap has no clean deploy boundary.
