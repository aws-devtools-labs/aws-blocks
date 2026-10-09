---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-logger": patch
"@aws-blocks/blocks": patch
---

fix: export the same names from every conditional entry point

Some Building Blocks were missing named exports from their `cdk` or `browser`
entry points, even though the TypeScript types said they were there. Importing
one of these names from code evaluated during `cdk synth`, or from a browser
bundle, failed at import time. Added:

- `cdk` entry: `InterruptError` (`@aws-blocks/bb-agent`), `BatchSubmitFailedError`
  (`@aws-blocks/bb-async-job`), and `RLSEnabledDatabase` and `PgClientEngine`
  (`@aws-blocks/bb-data`).
- `browser` entry: the error constants `AgentErrors`, `AppSettingErrors`,
  `EmailErrors`, `FileBucketErrors` and `LoggingErrors` (for `isBlocksError` checks
  in frontend code), plus `InterruptError`, `BedrockModels` and `OllamaModels`
  (`@aws-blocks/bb-agent`) and `fromExisting` (`@aws-blocks/bb-data`).

The conditional-exports regression test now compares every Building Block's
`aws-runtime`, `cdk` and `browser` entries against its default entry in both
directions, so these gaps can't come back unnoticed.
