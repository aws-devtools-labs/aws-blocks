---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
---

`Auth` lets you keep end users from writing an attribute your app relies on for authorization.

- New `UserAttribute.userWritable` option for `users.attributes` (default `true`). Set it to `false` for a role, tenant id, plan tier or similar. `signUp`, `updateUserAttributes` and the new-password step of `confirmSignIn` then reject the attribute with `NotAuthorizedException` before Amazon Cognito is called, locally too. Set it server-side with `admin.createUser`. A refused write logs one warning naming the attribute (never the value). It can't be combined with `required: true`, nor, while self sign-up is on, mapped from a provider's `attributeMapping`.
- The app clients now set their write attributes explicitly: the standard attributes except `email_verified` / `phone_number_verified`, plus the declared custom attributes not marked `userWritable: false`. The hosted-UI client, created when a provider federates through the pool, adds every attribute a provider maps. Before, neither set any, and Cognito's default lets an app client write every attribute. Both clients are updated in place.
- With `userPool: Auth.fromExisting(…)`, a custom attribute not declared in `users.attributes` can no longer be written through `signUp` or `updateUserAttributes` (`NotAuthorizedException`, locally too). Declare it to keep it user-writable; `admin.createUser` can still set it. The block's client in that pool now lists the declared custom attributes in its write attributes, so each attribute declared in `users.attributes` must exist in the pool: Cognito refuses a client whose write attributes name one the pool doesn't have, and the deploy fails.

Apps that write only standard and declared attributes need no changes.
