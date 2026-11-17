---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

On AWS, `Auth` checks user-attribute values itself before it calls Amazon Cognito, so a client that sends a value that isn't a string gets the same `400 InvalidParameterException` it gets under `npm run dev`. A JSON-RPC or native client can send any JSON, and the AWS SDK passes a number, boolean, object, array or `null` to Cognito as-is, which Cognito answers with `500 InternalErrorException`. `signUp`, `updateUserAttributes`, `admin.createUser` and the new-password step of `confirmSignIn` apply these rules first, and a rejected write makes no Cognito call: the value must be a string of at most 2,048 characters (`InvalidParameterException`), `sub` can't be written (`InvalidParameterException`), and `email_verified` / `phone_number_verified` can't be set through `signUp`, `updateUserAttributes` or `confirmSignIn` (`NotAuthorizedException`). `admin.createUser` can set them. Cognito checks attribute names and immutable attributes against your deployed user pool.
