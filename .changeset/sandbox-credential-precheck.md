---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

`sandbox` / `deploy`: fail fast with an actionable message when AWS credentials are missing or expired.

Both commands previously spent ~10 seconds synthesizing the CDK app before the first AWS call, so an unconfigured or expired credential surfaced only afterwards — as an opaque CDK/CloudFormation error that didn't name the real cause. `startSandbox` and `deploy` now run an STS `GetCallerIdentity` check up front and, if it fails, exit immediately with guidance (configure `aws configure` / `aws sso login`, set `AWS_PROFILE`, or export `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) instead of wasting the synth.
