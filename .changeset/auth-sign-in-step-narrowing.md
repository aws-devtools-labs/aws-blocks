---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth`'s sign-in results carry only the steps the configuration can produce. `signIn`, `confirmSignIn` and `autoSignIn` return `SignInResult<O>`, whose `nextStep` is `SignInNextStep<O>`: the MFA steps need `mfa` on, and each factor's steps need that factor in `mfa.types`; `CONFIRM_SIGN_IN_WITH_WEB_AUTHN` needs `passkeys`; the first-factor steps need `users.authFlow: 'USER_AUTH'`. With `mfa: 'off'` and no passkeys, a `switch` on `nextStep.name` handles three steps rather than fifteen. Every step is kept for a pool wrapped with `Auth.fromExisting`, for settings the compiler cannot see, and in the plain `SignInNextStep` type. Native clients get every step whatever the options.

Two compile errors name their cause: calling an `auth.admin` method without `admin` in the options reports the missing `ERROR_admin_is_not_enabled__construct_Auth_with_admin_options` argument, and passing `updateMfaPreference` a factor that `mfa.types` leaves out reports `ERROR_SMS_is_not_in_mfa_types` (or `TOTP` / `EMAIL`).
