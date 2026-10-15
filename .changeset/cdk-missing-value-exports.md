---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/blocks": patch
---

fix: export runtime values missing from the `cdk` entry points

Some values exported by a Building Block's default and `aws-runtime` entry points were missing from its `cdk` entry,
so a backend file importing them crashed `cdk synth` at load time — for example, the `InterruptError` import shown in
the `bb-agent` README failed with `does not provide an export named 'InterruptError'`. The `cdk` entries now also
export:

- `@aws-blocks/bb-agent`: `InterruptError`
- `@aws-blocks/bb-async-job`: `BatchSubmitFailedError`
- `@aws-blocks/bb-auth-cognito`: `SessionStore`; standalone session tables also enable DynamoDB TTL when a positive
  session lifetime is configured.
- `@aws-blocks/bb-data`: `RLSEnabledDatabase`, `PgClientEngine`

`@aws-blocks/blocks`: picks up the fixed `cdk` entries of the Building Blocks above. The conditional-export parity
test now also checks every Building Block's `cdk` entry.
