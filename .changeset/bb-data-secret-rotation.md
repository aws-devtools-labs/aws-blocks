---
"@aws-blocks/bb-data": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

`Database` now rotates its auto-generated `postgres` credentials secret every 30 days under the `production` preset, using AWS's PostgreSQL single-user rotation function (a Serverless Application Repository app: an AWS-maintained Lambda placed in the cluster's VPC): it generates a new password, sets it on the cluster and makes it the secret's current version. The secret keeps its ARN and the app never reads the password itself (the RDS Data API reads the secret for it), so a rotation needs no redeploy.

Rotation is off under the `sandbox` preset, where a teardown would wait on the rotation Lambda's network interfaces and the stack would pay for an interface endpoint it never benefits from. Set `secretRotation: true` to opt in.

- A `secretRotation` option turns rotation on (`true`), sets the interval (`{ intervalDays: n }`, 1–1000 days) or turns it off (`false`), and always wins over the stack-wide `defaults.secretRotation`. It is ignored, with a synth warning, for `fromExisting()` databases.
- In the Database's own VPC (isolated subnets, no NAT) a Secrets Manager interface endpoint is added so the rotation Lambda can reach the Secrets Manager API (billed hourly in each of its two AZs, about $7.20 per AZ per month in us-east-1). A dedicated security group admits only the rotation Lambda on 443, and the cluster security group admits only the rotation Lambda on the Postgres port.
- In a shared VPC (`defaults.vpc`) the rotation Lambda reuses the endpoint Blocks already provisions. With `provisionEndpoints: false` your own Secrets Manager endpoint's security group must admit the rotation Lambda's security group on 443; synth warns (`blocks:vpc:endpoint-client-unadmitted`) with the group to admit.
- With a `storageEncryptionKeyArn`, the rotation Lambda is granted `kms:Decrypt`, `kms:DescribeKey` and `kms:GenerateDataKey` on the key; the imported key's policy must allow the account's IAM principals to use it, which the default key policy does. If the key policy enumerates principals instead of delegating to the account root, the rotation Lambda's role must be among them; its ARN is only known after the first deploy.

`BlocksDefaults` gains an optional `secretRotation`, so no existing literal needs changing: both presets set it, and an absent value means off.

Two deploy-time requirements come with it, because the rotation function is an AWS Serverless Application Repository app: the CloudFormation execution role needs `serverlessrepo:GetApplication` and `serverlessrepo:CreateCloudFormationTemplate`, and rotation only deploys in the `aws`, `aws-cn` and `aws-us-gov` partitions (a concrete region outside them fails at synth). An app on the `production` preset gets rotation by upgrading, so a least-privilege bootstrap role or another partition needs `secretRotation: false`.

Existing stacks upgrade in place: rotation only adds resources; the cluster, its writer and the secret synthesize identically before and after this change, so there is no cluster replacement. The stack gains the `AWS::Serverless-2016-10-31` transform, and the first rotation runs during the deploy, after the writer is available and migrations have run; the deploy waits (up to five minutes) for it to finish.

Every rotation, scheduled ones included, has a window in which the cluster already accepts the new password while the secret still holds the old one, usually 1-3 seconds and occasionally up to about 18; a query in that window is refused, so the Data API engine now classifies that refusal as a connection failure and retries the statement for up to nine seconds (it is refused before it runs, so a retry cannot apply it twice). A statement inside a transaction is not retried, since every attempt would reuse one transaction id; the refusal surfaces so the caller can retry the whole transaction.

CDK also attaches a resource policy to the secret that denies `secretsmanager:DeleteSecret` to the account while rotation is on. `cdk destroy` still deletes the secret; an out-of-band `delete-secret` is refused.

Also fixed: with a `storageEncryptionKeyArn`, the app runtime and the migration Lambda were never granted `kms:Decrypt` on the key, so every Data API call, the first migration included, failed. The app runtime and the migration Lambda are now granted `kms:Decrypt` on the key, scoped to use through Secrets Manager.

In `@aws-blocks/core`, `VpcRequirements` gains `endpointClientSecurityGroups`, letting a Building Block register security groups of compute it provisions itself (such as the rotation Lambda) so they are admitted on the Blocks-managed interface-endpoint security group, and `endpointClientDependents`, so a construct that must not be created before that compute can reach the endpoints is ordered after them. When `provisionEndpoints: false` leaves the endpoints to you, Blocks warns for each registered group instead.
