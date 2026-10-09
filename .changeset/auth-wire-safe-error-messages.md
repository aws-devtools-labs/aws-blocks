---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Error messages sent to clients no longer include Amazon Cognito's raw text, matching `AuthCognito` 0.1.11.

Cognito's error messages can quote the request (a username, a rejected value) or name an endpoint, a role or your AWS account. `Auth` now sends a fixed message for each error `name` instead (for example `Invalid parameter` for `InvalidParameterException`), from every method, `auth.admin.*` and the `createApi()` Authenticator state, and the same message under `npm run dev` as on AWS. Cognito's own text is written to the server log, with the user's login redacted. Error `name`, HTTP status and `retriable` are unchanged, so code that matches errors with `isAuthError` keeps working. If you show `error.message` to users, they now see the shorter fixed message (for example, a weak password reads `Password does not meet the password policy` rather than naming the rule that failed). Errors you throw yourself as an `ApiError`, for example from `validateUser`, keep your message.
