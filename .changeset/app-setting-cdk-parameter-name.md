---
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/blocks": patch
---

`AppSetting`'s CDK construct now exposes two read-only properties at synth time: `parameterName`, the SSM parameter name the setting resolves to (the explicit `name`, the `AppSetting.fromExisting()` name, or the derived default `/<fullId>`), and `secret`, whether the parameter is a SecureString. Other Building Blocks' CDK layers can now reference the exact parameter instead of assuming the default name, so a secret created with a custom `name` or via `fromExisting()` can be passed where a Building Block needs a secret. The local and Lambda runtime APIs are unchanged.
