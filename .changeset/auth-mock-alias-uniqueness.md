---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

fix(bb-auth): the local user pool now keeps an email / phone unique, as Cognito does

Locally, two users could verify the same email, and signing in with it picked
whichever user came last. The local pool now follows Cognito's rules, so code that
works under `npm run dev` behaves the same when deployed:

- With sign-in aliases (`users.signInWith` with `'username'`, the default), an email
  or phone can be verified on one account only. A second user can still sign up
  with it, but `confirmSignUp` with the right code answers `AliasExistsException`
  (400) and leaves that user unconfirmed. `admin.createUser` answers
  `AliasExistsException` when it marks such an email / phone verified. If a signed-in
  user changes their email to one another account has verified and confirms it with
  `confirmUserAttribute`, the email moves to them and is unverified on the other
  account.
- When users sign in with their email / phone instead of a username (`signInWith`
  without `'username'`), `updateUserAttributes` to an email / phone another user
  already has answers `AliasExistsException`.

`AliasExistsException` from `confirmSignUp` is not hidden by
`revealExistingUsers: false`: only someone who received the code sent to that email
or phone can get it.
