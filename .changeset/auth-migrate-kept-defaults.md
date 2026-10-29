---
'@aws-blocks/bb-auth': patch
---

`bb-auth migrate` keeps two old defaults that `Auth` changed, so a migrated app behaves as before:

- **`AuthCognito` sign-up.** `AuthCognito`'s `signUp()` didn't sign the user in after `confirmSignUp()` unless it passed `autoSignIn: true`. `Auth`'s `emailPassword.autoSignIn` defaults to `true`. Unless the app uses `createApi()` (whose sign-in UI turned auto sign-in on) or `signUp(…, { autoSignIn: true })`, the codemod now writes `emailPassword: { autoSignIn: false }`, so `confirmSignUp()` keeps returning `DONE`. If the app does use them, `Auth`'s default stays, and each `signUp()` with a context that relied on the old `false` gets a TODO: `confirmSignUp()` now returns `COMPLETE_AUTO_SIGN_IN` there.
- **`AuthBasic` session length.** Without `sessionDuration`, `AuthBasic` sessions lasted 24 hours; `Auth`'s last 400 days. The codemod now writes `session: { ttlSeconds: 86_400 }`.

For options passed by variable or spread in, it leaves a TODO to add these instead.

It also leaves a TODO on the string literals `'SessionRevokedException'`, `'SignOutIncompleteException'` and `'AccountLockedException'`, which `Auth` never returns, and marks error checks on them for review. `MIGRATION.md` documents all of this, notes that `AuthBasic` error-name string literals are rewritten project-wide, and lists the "after it runs" steps in the same order as the codemod's summary.

`bb-auth migrate` now parses its arguments with Node's `parseArgs`. `--` ends the options, and `--help` together with an unknown option exits 2.
