---
'@aws-blocks/bb-app-setting': patch
---

`AppSetting.get()` on AWS now throws `AppSettingErrors.ParameterNotFound` when the SSM parameter does not exist, as documented, instead of the raw SDK `ParameterNotFound` exception.
