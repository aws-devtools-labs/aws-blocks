---
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/auth-common": patch
---

docs: the Auth docs describe the installed version

The design notes state how `Auth` works instead of what the earlier auth blocks did and which PR changed it. Statements a migrating app relies on stay: the construct ids of the user pool, app client and session secret, the cookie and local-state formats, `userId`, action names and error names match `AuthCognito`'s. The `errorName` example in the auth-common README uses `NotAuthorizedException`, an `AuthErrors` value.
