---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Error messages sent to clients no longer include Amazon Cognito's raw text, matching `AuthCognito` 0.1.11.

Cognito's error messages can quote the request (a username, a rejected value) or name an endpoint, a role or your AWS account. `Auth` now sends a fixed message for each error `name` instead (for example `Invalid parameter` for `InvalidParameterException`), from every method, `auth.admin.*` and the `createApi()` Authenticator state, and the same message under `npm run dev` as on AWS. Cognito's own text is written to the server log, with the user's login redacted. Error `name`, HTTP status and `retriable` are unchanged, so code that matches errors with `isAuthError` keeps working. If you show `error.message` to users, they now see the shorter fixed message (for example, `Invalid parameter` rather than the attribute Cognito rejected). A weak password is the one exception: its message is written from the password policy you configured, for example `Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number and a symbol.`, the same under `npm run dev` as on AWS. A pool you wrap with `Auth.fromExisting` keeps the fixed `Password does not meet the password policy`, because `Auth` doesn't know its policy. Errors you throw yourself as an `ApiError`, for example from `validateUser`, keep your message.
