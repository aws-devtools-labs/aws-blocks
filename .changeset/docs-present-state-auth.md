---
"@aws-blocks/bb-auth": patch
"@aws-blocks/auth-common": patch
---

docs: the Auth docs and doc comments describe the installed version

The design notes and type docs state how `Auth` works instead of what the earlier auth blocks did and which PR changed it. Statements a migrating app relies on stay: construct ids, cookie, session-row and local-state formats, `userId`, action names and error names match `AuthCognito`'s. The `errorName` example in the auth-common README uses `NotAuthorizedException`, an `AuthErrors` value.
