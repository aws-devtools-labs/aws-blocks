---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`requireAuth().attributes` and `getCurrentUser().attributes` hold the ID token's string claims, the same locally and on AWS, so they don't include `updated_at` or `address`. Amazon Cognito's ID token carries `updated_at` as a number and `address` as an object (`{ formatted }`). `AuthCognito`'s mock reported both as strings there, which a deployed app never saw. The local ID token (`getAuthSession`) and the `claims` passed to `validateUser` carry them in Cognito's shapes. To read either as a string, call `auth.getUserAttributes(context)`, which returns them the same way on both.

The sign-in UI's `displayName` reads whether an email or phone number is verified from the session's ID token, the same way on both, so it skips an unverified email or phone number. That covers an email the user changed with `updateUserAttributes` and hasn't confirmed yet, once the session's tokens are refreshed. It works the same for a user who signs in directly with an OIDC provider that marks their email unverified, whether the provider sends `email_verified` as a boolean or as a string.
