---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`requireAuth().attributes` and `getCurrentUser().attributes` don't include `email_verified` or `phone_number_verified`, locally or on AWS. Amazon Cognito's ID token carries these flags as booleans rather than string attributes, so a deployed app never sees them there. `AuthCognito`'s mock reported them as `'true'` / `'false'` strings, so code that read them worked only under `npm run dev`. To check whether a user's email or phone number is verified, call `auth.getUserAttributes(context)`, which returns them as `'true'` / `'false'` on both. The local ID token (`getAuthSession`) and the `claims` passed to `validateUser` carry these flags as booleans, as Cognito's do.
