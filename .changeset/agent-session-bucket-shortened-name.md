---
'@aws-blocks/bb-agent': patch
'@aws-blocks/blocks': patch
---

A deployed `Agent` whose session bucket name is shortened now saves its conversation state. When a long stack name (common in production) pushes the agent's internal session bucket name past S3's 63-character limit, `FileBucket` provisions a shortened name, but the deployed agent kept writing to the original, unshortened name: every turn failed with `StreamFailedException: Failed to write S3 object …/snapshot_latest.json`. The agent now uses the bucket's actual name. Agents whose bucket name already fit are unchanged.
