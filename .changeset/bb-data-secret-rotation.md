---
"@aws-blocks/bb-data": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

`Database` now rotates its auto-generated `postgres` credentials secret every 30 days, using AWS's rotation function for PostgreSQL, deployed into the cluster's VPC: it generates a new password, sets it on the cluster and makes it the secret's current version. The secret keeps its ARN and the app never reads the password itself (the RDS Data API reads the secret for it), so a rotation needs no redeploy.

- A `secretRotation` option sets the interval (`{ intervalDays: n }`, 1–1000 days) or turns rotation off (`false`). It is ignored, with a synth warning, for `fromExisting()` databases.
- In the Database's own VPC (isolated subnets, no NAT) a Secrets Manager interface endpoint is added so the rotation Lambda can reach the Secrets Manager API (billed hourly in each of its two AZs, about $7.20 per AZ per month in us-east-1); a dedicated security group admits only the rotation Lambda on 443, and the cluster security group admits only the rotation Lambda on the Postgres port. In a shared VPC (`defaults.vpc`) the rotation Lambda reuses the endpoint core already provisions. With `provisionEndpoints: false` your own Secrets Manager endpoint's security group must admit the rotation Lambda's security group on 443; synth warns (`blocks:vpc:endpoint-client-unadmitted`) with the group to admit.
- With a `storageEncryptionKeyArn`, the rotation Lambda is granted `kms:Decrypt`, `kms:DescribeKey` and `kms:GenerateDataKey` on the key; the imported key's policy must allow the account's IAM principals to use it, which the default key policy does. If the key policy enumerates principals instead of delegating to the account root, the rotation Lambda's role must be among them; its ARN is only known after the first deploy.

Existing stacks upgrade in place: rotation only adds resources; the cluster, its writer and the secret synthesize identically before and after this change, so there is no cluster replacement. The stack gains the `AWS::Serverless-2016-10-31` transform, and the first rotation runs during the deploy, after the writer is available and migrations have run. CDK also attaches a resource policy to the secret that denies `secretsmanager:DeleteSecret` to the account while rotation is on. `cdk destroy` still deletes the secret; an out-of-band `delete-secret` is refused.

Also fixed: with a `storageEncryptionKeyArn`, the app runtime and the migration Lambda were never granted `kms:Decrypt` on the key, so every Data API call, the first migration included, failed. The app runtime and the migration Lambda are now granted `kms:Decrypt` on the key, scoped to use through Secrets Manager.

In `@aws-blocks/core`, `VpcRequirements` gains `endpointClientSecurityGroups`, letting a Building Block register security groups of compute it provisions itself (such as the rotation Lambda) so they are admitted on the Blocks-managed interface-endpoint security group. When `provisionEndpoints: false` leaves the endpoints to the customer, Blocks warns for each registered group instead.
