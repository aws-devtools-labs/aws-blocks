---
'@aws-blocks/bb-app-setting': patch
'@aws-blocks/blocks': patch
---

`AppSetting.put()` on AWS now enforces the documented 4 KB limit before writing, the same way the local mock does: a non-secret value whose JSON serialization exceeds 4096 UTF-8 bytes throws `AppSettingErrors.ValidationFailed` and is not sent to SSM. Previously the AWS path sent every value to SSM, so a value the mock rejects with `ValidationFailed` was left to SSM's own limit check on AWS, which fails with an unnamed SDK exception. Both paths now share one check, called after schema validation.
