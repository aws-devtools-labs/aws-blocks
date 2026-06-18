---
"@aws-blocks/bb-auth-cognito": patch
---

fix(bb-auth-cognito): discriminate `SignInResult` on a string `status` field

`SignInResult` (from `signIn` / `confirmSignIn` / `autoSignIn`) now discriminates
on a string `status` (`'signedIn' | 'continueSignIn'`) instead of the `isSignedIn`
boolean, so native-client codegen (Swift / Kotlin / Dart) emits clean, named,
switch-decoded variants. Narrow with `if (result.status === 'signedIn')`.

Breaking change to the `SignInResult` shape (pre-release): `isSignedIn` is removed,
not aliased.
