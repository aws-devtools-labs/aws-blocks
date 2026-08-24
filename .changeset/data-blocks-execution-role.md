---
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-agent": patch
---

refactor(bb): attach IAM grants to the shared execution role

Data and auth blocks now grant permissions to the shared Blocks execution role
(`this.executionRole`) instead of the handler function directly. Grants land on
the same role the handler assumes, so the effective runtime permissions are
identical — this decouples IAM wiring from the concrete Lambda function ahead of
the multi-compute model.

For `bb-distributed-data`, the DSQL endpoint and region now flow through the
config registry (loaded into `process.env` at cold start, like every other
block) rather than being set as direct handler environment variables, and the
migration Lambda maps the shared execution role's ARN.
