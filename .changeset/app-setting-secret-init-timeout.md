---
"@aws-blocks/bb-app-setting": patch
---

Give the secret-init custom-resource Lambda (`BlocksSecretInitFn`) an explicit 2-minute timeout. It previously ran with Lambda's 3-second default, so a slow cold start could fail the `BlocksSecretsBulk` custom resource with "Task timed out after 3.00 seconds" and roll back the deploy of any stack that uses `AppSetting` with `secret: true`.
