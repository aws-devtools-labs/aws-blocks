---
"@aws-blocks/hosting": patch
---

fix(hosting): disable per-deploy API Gateway CloudWatch role on SSR RestApi

The SSR RestApi took CDK's default `cloudWatchRole: true` (the
`aws-apigateway:disableCloudWatchRole` feature flag is unset for a bare `App`),
so every hosting deploy minted a fresh account-level CloudWatch Logs IAM role.
The stage enables no access logging, so that role was never used — pure dead
weight that accumulates one orphaned role per deploy and can exhaust an
account's `RolesPerAccount` quota across many deploys.

Pass `cloudWatchRole: false`, matching how the rest of the repo
(`bb-lambda-compute`, `bb-realtime`) opts out and provisions a single shared
account role only where a stage actually logs. The synthesized template now
carries one fewer IAM role and no `AWS::ApiGateway::Account`.
