---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

docs(bb-auth): the README documents the password policy

A new "Password policy" section covers `emailPassword.passwordPolicy`: each `PasswordPolicy` field and its default (8 characters, with an uppercase letter, a lowercase letter, a digit and a symbol), the calls that enforce it, and what a client receives for a password that breaks it (`InvalidPasswordException`, 400, retriable through `setAuthState`, with a message that describes the policy). It also shows how to branch on the error with `isAuthError` or `hasAuthError`.
