---
"@aws-cdk-blocks/bb-app-setting": patch
---

docs: `value` is required unless `secret: true`. `ParameterNotFound` is thrown on AWS only. `get()` parses the stored text as JSON, so a console value such as `12345` comes back as a number. `fromExisting` does not create the parameter or grant write access.
