---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
'@aws-blocks/create-blocks-app': patch
---

End users can now write only the custom attributes you mark `userWritable: true` in `users.attributes`. `signUp` (including the `createApi()` sign-up form), `updateUserAttributes` and the new-password step of `confirmSignIn` reject any other `custom:` attribute, bare or prefixed, with `401 NotAuthorizedException` and store nothing; a name whose `custom:` prefix differs only in case or surrounding whitespace is rejected too. `admin.createUser` still writes every declared attribute. On a user pool the block creates, the app client's `WriteAttributes` now list the standard attributes and only the `userWritable` custom attributes (an in-place update of the client). With `userPool: Auth.fromExisting(…)`, declare the custom attributes your users write themselves with `userWritable: true`.

**Migration:** add `userWritable: true` to each custom attribute your users edit themselves, such as a profile field. Leave it off attributes your app uses to decide what a user may do (a role, a tenant, a plan) and set those with `auth.admin.createUser`. A `required: true` attribute must also be `userWritable: true`; the block refuses the combination at construction. `mutable` keeps its default of `true`. The `create-blocks-app` auth template marks its `department` attribute `userWritable`.
