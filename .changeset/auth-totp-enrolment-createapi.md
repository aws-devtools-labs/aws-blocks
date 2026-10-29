---
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": minor
"@aws-blocks/core": patch
---

A signed-in user can enrol an authenticator app (TOTP) through `auth.createApi()`, with no backend code: `setAuthState` takes `setUpTotp`, `verifyTotpSetup`, `getMfaPreference` and `updateMfaPreference` actions. `setUpTotp` returns a state whose `verifyTotpSetup` action carries the shared secret (`sharedSecret`) and an `otpauth://` URI (`otpauthUri`, the QR code's content) as hidden fields; the other actions return the user's MFA settings, one `updateMfaPreference` action per change they can make. A wrong code is `retriable`; a caller who is not signed in gets the `NotAuthenticatedException` state. Replacing an enrolled authenticator and setting a factor `'DISABLED'` need a recent sign-in (`session.freshAgeSeconds`); a stale session gets the `ReauthenticationRequiredException` state, so a stolen session cookie cannot swap the authenticator or turn MFA off. The actions follow the block's options, in the frontend too: `setUpTotp` / `verifyTotpSetup` need `mfa` on with `'TOTP'` in `mfa.types` (`TotpEnabled<O>`), the preference actions need `mfa` on and take only the factors in `mfa.types`; untyped callers get `MfaNotEnabledException` or `InvalidParameterException`. The new `mfa.totpIssuer` option sets the issuer authenticator apps show (default: the root `Scope` id).

`MfaSettings(authApi, options?)` (from `@aws-blocks/blocks/ui`, `@aws-blocks/bb-auth/ui` or `@aws-blocks/auth-common/ui`) is the enrolment panel for an account page: the setup key, an `otpauth://` link and, with `renderQrCode`, a QR code from the library of your choice, then the code form and the preference buttons, each a `<form>` with stable `mfa-settings-*` test hooks. It leaves the shared auth-state store alone, so a mounted `Authenticator` is unaffected; the `Authenticator`'s signed-in card does not change.

Native clients: the `setAuthState` input union gains the four actions (additive). Code that matches exhaustively over that input needs the new cases: an exhaustive Swift `switch` over the `Input` enum, a Kotlin `when` over the sealed input class used as an expression, and a Dart `switch` over the sealed input class.

Dev-server logs redact `otpauth` fields (`otpauthUri` embeds the TOTP secret).
