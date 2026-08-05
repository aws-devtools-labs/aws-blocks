---
"@aws-blocks/bb-auth-cognito": patch
---

Enable `PreventUserExistenceErrors` on the Cognito user pool client. Sign-in and forgot-password responses now return a uniform error regardless of whether the username exists, closing the account-enumeration oracle that Cognito exposes by default (distinct `UserNotFoundException` vs. wrong-password errors).
