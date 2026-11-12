---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(core,hosting): require source conditions on KMS key policies that name a service principal

The synth-time service-principal check now also reads the key policy of every KMS key in the scopes it covers. An `Allow` statement that names an AWS service principal must carry `aws:SourceAccount` or `aws:SourceArn`, `kms:EncryptionContext:aws:logs:arn` (CloudWatch Logs), or `kms:ViaService` with `kms:CallerAccount`. `…IfExists`, `Null` and `ForAllValues:` operators and `*`-only values don't count. A key AWS Blocks creates fails synth; a key your app creates gets a warning, which you can acknowledge with the id `@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition`.

The `Hosting` alarm topic key (regional and `us-east-1` monitoring stacks) now grants `cloudwatch.amazonaws.com` with `StringEquals aws:SourceAccount` and `ArnLike aws:SourceArn` (`arn:<partition>:cloudwatch:<region>:<account>:alarm:*`) in place of `StringEqualsIfExists aws:SourceAccount`. Alarm notifications are still delivered.
