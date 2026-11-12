---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` doesn't reveal whether an account exists, or whether it is already confirmed, on the steps after the sign-up form. With `emailPassword.revealExistingUsers` off (the default), an unknown user, an unconfirmed user and an already-confirmed user get identical answers from `confirmSignUp` (the wrong-code error, also for an expired code), `resendSignUpCode` (a silent success; a confirmed user is not sent a code), `resetPassword` (the same delivery details) and `confirmResetPassword` (the wrong-code error). This applies through the sign-in UI and when you call these methods directly. (`AuthCognito` passed Cognito's distinct errors through, so confirming or resending a code for an already-confirmed account let anyone check which accounts exist; an app moving to `Auth` gets the masked answers.) Set `revealExistingUsers: true` to get the informative errors.

The local runtime answers these steps the way Cognito does. Confirming an already-confirmed user fails, and resending a sign-up code to one sends nothing. A password reset for an unconfirmed or disabled user sends no code. A `USER_AUTH` sign-in for an unknown user gets a first-factor challenge that no answer can pass.
