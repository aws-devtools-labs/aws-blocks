---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Under `npm run dev`, confirming a sign-up verifies only the contact the confirmation code was sent to, as Amazon Cognito does: the phone number when the pool auto-verifies phone numbers and the user gave one, otherwise the email address. (`AuthCognito`'s mock marked both the email and the phone number verified.) The default pool (`signInWith: ['username', 'email']`) auto-verifies email only, so a user who signs up with an email and a phone number has an unverified phone number, locally and on AWS.

This shows up in the display name, in which one-time-code sign-in options (`EMAIL_OTP` / `SMS_OTP`) are offered, in SMS and email MFA, and in `getMfaPreference`. To use the other contact, verify it after sign-in with `auth.sendUserAttributeVerificationCode(context, 'phone_number')` and `auth.confirmUserAttribute(context, 'phone_number', code)`, which work the same locally and on AWS.
