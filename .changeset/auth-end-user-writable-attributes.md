---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
---

`Auth` lets you keep end users from writing an attribute your app relies on for authorization.

- New `UserAttribute.userWritable` option for `users.attributes` (default `true`). Set it to `false` for a role, tenant id, plan tier or similar. `signUp`, `updateUserAttributes` and the new-password step of `confirmSignIn` then reject the attribute with `NotAuthorizedException` before Amazon Cognito is called, locally too. Set it server-side with `admin.createUser`. It can't be combined with `required: true`.
- The app client now sets its write attributes explicitly: the standard attributes except `email_verified` / `phone_number_verified`, plus the declared custom attributes not marked `userWritable: false`. Before, it set none, and Cognito's default lets an app client write every attribute. The client is updated in place.
- With `userPool: Auth.fromExisting(…)`, a custom attribute not declared in `users.attributes` can no longer be written through `signUp` or `updateUserAttributes` (`NotAuthorizedException`, locally too). Declare it to keep it user-writable; `admin.createUser` can still set it.

Apps that write only standard and declared attributes need no changes.
