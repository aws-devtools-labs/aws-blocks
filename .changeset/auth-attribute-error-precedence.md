---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` gives the same error for the same invalid sign-up or attribute update under `npm run dev` and on AWS.

- On a pool with `emailPassword: { selfSignUp: false }`, `signUp` always fails with `401 NotAuthorizedException`, whatever attributes it was sent, and on AWS makes no Amazon Cognito call.
- When one write to `signUp`, `updateUserAttributes`, `admin.createUser` or the new-password step of `confirmSignIn` breaks several attribute rules, both runtimes report the same one, whatever order the attributes are in: a value that isn't a string, then a value longer than 2,048 characters (both `400 InvalidParameterException`), then `email_verified` / `phone_number_verified` set through a client call (`401 NotAuthorizedException`), then an attribute your user pool doesn't have, `sub`, or an immutable attribute (`400 InvalidParameterException`). For example, `{ 'custom:undeclared': 'x', email_verified: 'true' }` on `signUp` is `401 NotAuthorizedException` on both.
