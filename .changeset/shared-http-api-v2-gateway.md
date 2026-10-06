---
"@aws-blocks/core": minor
"@aws-blocks/bb-lambda-compute": minor
---

Replace the per-compute API Gateway REST API with a single stack-level shared HTTP API v2 gateway.

`LambdaCompute` now owns only its Lambda function (and handler log group); the stack/backend provisions one shared `HttpApi` (v2, payload format 2.0) that fronts the compute's function via a `$default` catch-all route (the Lambda does path routing). Request throttling and optional JSON access logging move from the per-compute REST stage to the shared HTTP API stage — HTTP API access logging needs no account-level CloudWatch Logs role (`AWS::ApiGateway::Account`). CORS stays Lambda-enforced from `CORS_ALLOWED_ORIGINS` (the framework's allowed origins are regex patterns that native HTTP API CORS can't express), so OPTIONS flows through the catch-all to the function. The runtime handler parses HTTP API v2 (payload format 2.0) events — `rawPath`, `rawQueryString`, inbound `cookies[]`, and the outbound `cookies` response field; the shared gateway is the handler's only HTTP producer, so there is no REST v1 event path. The gateway grants the function an explicit `{apiId}/*/*` API Gateway invoke permission covering the `$default` route — CDK's integration permission uses a REST-style `{apiId}/*/*/*` ARN that the HTTP API `$default` route's invoke ARN doesn't match, which would otherwise 500 every request with the Lambda never invoked.

BREAKING (pre-release): `BlocksStack.gateway` / `BlocksBackend.gateway` now return an HTTP API v2 `IHttpApi` (`aws-cdk-lib/aws-apigatewayv2`) instead of a REST `RestApi` (`aws-cdk-lib/aws-apigateway`). The deployed `apiUrl` no longer contains a stage path segment (`…/aws-blocks/api` instead of `…/{stage}/aws-blocks/api`), and `LambdaCompute` no longer exposes `apiGateway` / `apiUrl`.
