---
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/auth-common": patch
"aws-cdk-blocks": patch
---

Document `Auth` setup, options, error handling, and local versus AWS behavior. Clarify that sessions default to 30 days and that users must sign in again after migrating from `AuthCognito`. The `auth-common` README now lists the auth error names and shows how browser clients can match them.
