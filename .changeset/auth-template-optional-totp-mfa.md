---
'@aws-blocks/create-blocks-app': patch
---

The `auth` template now turns on optional MFA with an authenticator app (TOTP): a user who sets one up is asked for its code at sign-in, and everyone else signs in with their password as before. Locally the template checks those codes as Cognito does, and its end-to-end tests cover setting up an authenticator app and signing in with it.
