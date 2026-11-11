---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

`AuthCognito` now limits which attributes end users can write at sign-up and through `updateUserAttributes`.

- Only standard attributes and declared `userAttributes` are accepted. Undeclared or unknown attributes, and `email_verified` / `phone_number_verified`, are rejected with `InvalidParameterException`. The local mock behaves the same.
- New `UserAttribute.userWritable` option (default `true`). Set it to `false` for an attribute your app relies on for authorization, such as a role or tenant id; end users then can't set it, and it can be set only server-side (for example `admin.createUser`). It can't be combined with `required: true`.
- The app client now sets its write attributes explicitly to that same set, so Cognito enforces it too.

Apps that pass only standard and declared attributes need no changes.
