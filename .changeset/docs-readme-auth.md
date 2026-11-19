---
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/auth-common": patch
"aws-cdk-blocks": patch
---

Document `Auth` setup, options and error handling. Sessions default to 30 days, users sign in again after migrating from `AuthCognito`, and `rememberDevice` on AWS reports `InvalidParameterException` (501). The `auth-common` README lists the auth error names and shows how browser clients can match them.
