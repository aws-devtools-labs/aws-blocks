---
'@aws-blocks/core': minor
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/blocks': minor
'@aws-blocks/admin-ui': patch
---

**Breaking: telemetry now follows your CDK CLI telemetry setting, and the AWS Blocks opt-out is removed.** `AWS_BLOCKS_DISABLE_TELEMETRY`, the `cdk-blocks telemetry` command, the `blocks-telemetry` binary and the `telemetry.enabled` key in `.blocks/config.json` are gone, with no fallback and no migration, so if you opted out that way you are opted back in until you opt out through CDK.

Opt out with `CDK_DISABLE_CLI_TELEMETRY` set to `1` or `true`, with `cdk cli-telemetry --disable`, or with `cli-telemetry: false` in the `context` of `cdk.json` or `~/.cdk.json`. CDK documents those settings at https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out. The values are matched exactly as the CDK CLI matches them, so `TRUE` and `yes` are not an opt-out. `CDK_BLOCKS_DISABLE_TEMPLATE_METADATA`, which governs the `AWSToolsMetrics` entry in the CloudFormation template, is a separate switch and is unchanged.
