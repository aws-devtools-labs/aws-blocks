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

fix: actionable errors for runtime methods called during `cdk synth`, and `Metrics.fromExisting()` under `cdk`

Calling a Building Block's runtime method (for example `db.query()`, `bucket.put()`, `auth.requireAuth()`) at the top
level of a backend module runs it during `cdk synth`. For many Building Blocks this failed with a cryptic
`TypeError: x is not a function`; it now throws the same actionable error the other Building Blocks already give:
`<Class>.<method>() cannot be called during CDK synth. Data methods run at request time — …`.

`Metrics.fromExisting()` was missing under `cdk`, so the documented
`new Metrics(scope, 'legacy', { metrics: Metrics.fromExisting('MyOrg/SharedMetrics') })` crashed `cdk synth`. It is
now available there too.

`@aws-blocks/blocks`: the conditional-export parity test now also compares the public methods of every exported
Building Block class across the default, `aws-runtime`, and `cdk` entry points.
Instance methods and static helpers are checked separately, with intentional omissions scoped to each condition.
A CDK regression test also covers the Metrics guard errors and `Metrics.fromExisting()` behavior.
