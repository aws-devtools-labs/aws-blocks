---
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/blocks": patch
---

fix(bb-distributed-data): re-run the DSQL role grant when the app's IAM role is replaced

`DistributedDatabase` maps the app's IAM role ARN to a DSQL database role with
`AWS IAM GRANT`. The migration/provisioning CustomResource is documented as running
on every deploy so the mapping "stays in sync if the app Lambda's IAM role is
recreated", but its properties were `{ migrationsHash, dbRole }` only — the role ARN
reached the Lambda as an environment variable and nothing else.

CloudFormation re-invokes a CustomResource only when its **properties** change. When
an IAM role replacement changed the ARN while migrations stayed the same, both
properties were unchanged, so CloudFormation skipped the resource entirely. The
Lambda's `APP_ROLE_ARN` env var was updated but the function was never called, leaving
the DSQL grant pointing at the old, deleted ARN. Every query then failed with SQLSTATE
`28000` (`invalid_authorization_specification`, "unable to accept connection, access
denied") while the deploy itself reported success and the IAM policy still showed a
correct `dsql:DbConnect` — the breakage lived in DSQL's internal role mapping, which is
invisible from the CloudFormation layer.

`appRoleArn` is now a CustomResource property, so a role replacement re-invokes the
resource and `provisionAppRole()` re-issues the grant as part of the deploy. The value
is a CDK token, so it differs only when the role is genuinely replaced — this does not
force the resource to run on every deploy.

This was latent from the initial version and stayed dormant while each Lambda kept its
own stable execution role. It surfaced once the shared execution role landed (#320,
#341): upgrading `@aws-blocks/core` across that range replaces the per-Lambda
`HandlerServiceRole` with the shared `BlocksRole`, which is exactly the role-ARN change
that the CustomResource failed to notice.

`@aws-blocks/blocks` gets a `patch` bump because it re-exports `bb-distributed-data`
(satisfies the umbrella publish guard); no umbrella source changed.

Fixes #556.
