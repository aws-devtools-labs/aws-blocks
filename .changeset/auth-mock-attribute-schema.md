---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Under `npm run dev`, `Auth` checks user attributes against your user pool's schema, as Amazon Cognito does on AWS, so an invalid write fails locally instead of only after you deploy. (`AuthCognito`'s mock stored any attribute it was sent.) `signUp`, `updateUserAttributes` and `admin.createUser` fail with `InvalidParameterException` for an attribute that is neither a standard attribute nor declared in `users.attributes`, a value that isn't a string, or a value longer than 2,048 characters. Updating a custom attribute declared `mutable: false` also fails with `InvalidParameterException`. Setting `email_verified` or `phone_number_verified` through `signUp` or `updateUserAttributes` fails with `NotAuthorizedException`; `admin.createUser` can set them. To store a custom attribute, declare it in `users: { attributes: [{ name: 'team' }] }`, then write it as `team` or `custom:team`.

A local password reset sends its code the way Cognito does: to a verified phone number first, then to a verified email address, but never to the contact the user has chosen as their preferred MFA factor. A user with no verified contact gets no code. Like any account Cognito can't reset, they get the usual masked "code sent" answer (or `InvalidParameterException` when `emailPassword.revealExistingUsers` is on). `AuthCognito`'s mock sent the code to the email address if the user had one, otherwise the phone number, whether or not it was verified.
