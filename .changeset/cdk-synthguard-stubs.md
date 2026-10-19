---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-metrics": patch
"@aws-blocks/bb-tracer": patch
"@aws-blocks/blocks": patch
---

fix: actionable errors for runtime methods called during `cdk synth`

Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`, or
`auth.admin`) at the top level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with
a cryptic `TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already
give: `<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.
