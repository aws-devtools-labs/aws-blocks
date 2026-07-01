---
'@aws-blocks/core': patch
'@aws-blocks/bb-data': patch
'@aws-blocks/create-blocks-app': patch
---

fix: stack-scope the external-DB connection-string SSM parameter to prevent multi-app collision

The external-database connection string was stored in an SSM parameter named only
by stage (`/blocks/{stage}/db-connection-string`), so two Blocks apps deployed to
the same AWS account + region + stage computed the same name and silently
overwrote each other's credentials.

The parameter name is now stack-scoped (`/<stackName>-db-url`), derived from a
single new `getStackName({ sandbox, projectRoot })` helper that is also the one
place the CDK templates compute the stack name (replacing logic duplicated across
templates). The same `dbConnectionParameterName(stackName)` — fed the stack name
from `getStackName({ sandbox, projectRoot })` — is used
by the pre-deploy writer (`ensureSecrets`) and by the `db pull` generated wiring at
synth, so the written name and the read name are derived once, from committed
config (`.blocks/config.json`) — never from the connection string — and cannot
diverge. The name is computable before synth (enabled by the committed stackId from
PR #51), so no post-deploy write-back or staging-copy machinery is needed.

The previous stage-only parameter is orphaned and self-heals on the next deploy.
