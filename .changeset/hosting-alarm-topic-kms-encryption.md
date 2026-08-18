---
"@aws-blocks/hosting": patch
---

fix(hosting): encrypt the alarm SNS topic by default, with a key policy CloudWatch can actually use

The monitoring construct's auto-created alarm topic was unencrypted. It now gets
a dedicated customer-managed KMS key (`MonitoringAlarmTopicKey`) whose policy
grants `cloudwatch.amazonaws.com` `kms:Decrypt` + `kms:GenerateDataKey*` in
addition to the usual account-root administration statement.

Both halves matter. Encrypting the topic makes hosting secure-by-default, and
the CloudWatch grant is what keeps alarms working once it is encrypted: when an
SNS topic used as a CloudWatch alarm action is KMS-encrypted, the key policy
must grant the `cloudwatch.amazonaws.com` service principal, because CloudWatch
calls KMS **directly** (not via SNS) and an account-root `kms:*` statement does
not cover AWS service principals. Without the grant, CloudWatch's publish fails
with `KMSAccessDenied` and notifications are dropped silently — the alarm still
transitions to ALARM in the console, so the only symptom is the notification
that never arrives.

An AWS-managed key (`alias/aws/sns`) cannot be used instead: its key policy is
not editable and does not grant CloudWatch, so a customer-managed key is the
only option that can carry the grant.

The grant is scoped to just those two actions for that one service principal on
a single-purpose key, plus a `StringEqualsIfExists` guard on `aws:SourceAccount`
against cross-account confused-deputy use. `IfExists` is deliberate:
`aws:SourceAccount` is only populated on direct service-principal calls, and a
hard `StringEquals` would reintroduce the very silent deny this grant exists to
prevent.

No configuration changes: encryption is unconditional, with no opt-out knob to
weaken it. The only API addition is a read-only `encryptionKey` accessor on
`MonitoringConstruct`, alongside the existing `topic` and `alarms`, so callers
can grant additional publishers on the key. Callers who need different key
management continue to pass their own `snsTopic` / `snsTopicArn` and own that
topic's encryption. Note the KMS key adds roughly $1/month per stack, and
monitoring is on by default; `monitoring: { enabled: false }` or a BYO topic
avoids it.
