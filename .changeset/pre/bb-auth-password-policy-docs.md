---
'@aws-cdk-blocks/bb-auth': patch
'aws-cdk-blocks': patch
---

docs(bb-auth): the README documents the password policy

A new "Password policy" section covers `emailPassword.passwordPolicy`: each `PasswordPolicy` field and its default (8 characters, with an uppercase letter, a lowercase letter, a digit and a symbol), the range of `minLength` (6 to 99, checked at synth, not locally), the calls that enforce it, and what a client receives for a password that breaks it (`InvalidPasswordException`, 400, retriable through `setAuthState`, with a message that describes the policy). It names the two places where the local user pool differs from AWS: a generated temporary password is checked against the policy, and an imported pool keeps the block's policy locally. A new recipe, "Tell the user what a password needs", sets a policy and branches on the error with `hasAuthError`; the README recipe test compiles it.
