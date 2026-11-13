---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(core,hosting): require source conditions on KMS key policies that name a service principal

The synth-time service-principal check now also reads the key policy of every KMS key in the scopes it covers. An `Allow` statement that names an AWS service principal must carry `aws:SourceAccount` or `aws:SourceArn`, or `kms:EncryptionContext:aws:logs:arn` for CloudWatch Logs. `events.amazonaws.com` is exempt for `kms:GenerateDataKey*` and `kms:Decrypt`, because Amazon SNS documents that these conditions stop EventBridge from publishing to an encrypted topic. A key AWS Blocks creates fails synth; a key your app creates gets a warning, which you can acknowledge with the id `@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition`.

A condition now counts, for key policies and for role trust policies alike, only under a positive string or ARN operator (`StringEquals`, `StringLike`, `ArnLike`, …, or their `ForAnyValue:` forms) and with a value that names an account. `…IfExists`, negated (`StringNotEquals`, `ArnNotLike`, …), `Null` and `ForAllValues:` operators don't count. Neither does `*` alone, a wildcard `aws:SourceAccount`, or an ARN whose account segment is empty or a wildcard. A role or key your app creates that relied on one of these forms now gets the synth warning.

The `Hosting` alarm topic key (regional and `us-east-1` monitoring stacks) now grants `cloudwatch.amazonaws.com` with `StringEquals aws:SourceAccount` and `ArnLike aws:SourceArn` (`arn:<partition>:cloudwatch:<region>:<account>:alarm:*`) in place of `StringEqualsIfExists aws:SourceAccount`. Alarm notifications are still delivered.
