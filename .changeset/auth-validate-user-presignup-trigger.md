---
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": patch
---

feat(bb-auth): `validateUser` also guards users created outside your app, through a Cognito PreSignUp trigger

When you set `validateUser` and `Auth` creates the user pool, the pool gets a Cognito PreSignUp trigger that runs your `validateUser` in your backend Lambda. It checks every user Cognito is about to create, including the ones your app never sees: a `SignUp` sent straight to Cognito with the app client id, an `AdminCreateUser` from the console or CLI, and the first sign-in of a social, SAML or `federateVia: 'cognito'` user.

- `auth.signUp()` runs `validateUser` first, in your request, and the trigger recognises that sign-up, so the check runs once. `auth.admin.createUser()` runs it too (`phase: 'signUp'`, `provider: 'password'`).
- A rejection in the trigger reaches the client with the same `AuthErrors` name and message you threw, masked the same way as in-process. The trigger never confirms or verifies a user.
- Without `validateUser`, no trigger is added. Adding or removing the option later updates the pool in place. On a pool wrapped with `userPool: Auth.fromExisting(...)`, no trigger is attached and synth warns.
- Cognito waits at most 5 seconds for the trigger, and a cold start of your Lambda counts, so keep `validateUser` fast.
