---
"@aws-blocks/bb-auth": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/blocks": patch
---

`Auth` names the option that is off when an untyped caller (plain JavaScript, or a native client generated from the wide spec) sends an action the block does not offer, before the session check or any Cognito call. A passkey action (`signInWithPasskey`, `startPasskeyRegistration`, `completePasskeyRegistration`, `listPasskeys`, `deletePasskey`) or a `confirmSignIn` `webauthn` challenge on a block without `passkeys` answers `PasskeysNotEnabledException` (409). A `confirmSignIn` MFA challenge (`code`, `mfaType`, `totpSetup`, `email`) with MFA off answers `MfaNotEnabledException` (409). A factor outside `mfa.types`, or a `password` / `firstFactor` challenge without `users.authFlow: 'USER_AUTH'`, answers `InvalidParameterException` naming the option. A block that wraps a pool with `userPool: Auth.fromExisting(…)` keeps every challenge.

The runtime backstops of the MFA methods (`setUpTotp`, `verifyTotpSetup`, `updateMfaPreference`, `getMfaPreference`) throw `MfaNotEnabledException` with MFA off, and those of the passkey methods throw `PasskeysNotEnabledException` without `passkeys`. `WebAuthnNotEnabledException` is Cognito's answer for a user pool without a WebAuthn configuration.

`@aws-blocks/auth-common`'s `AuthErrors` gains `PasskeysNotEnabled` and `MfaNotEnabled`.
