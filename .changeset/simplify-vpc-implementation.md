---
"@aws-blocks/core": minor
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/bb-auth-oidc": patch
---

Simplify VPC implementation: replace `registerVpcEndpoint` (instanceof-based) with two explicit methods (`registerVpcGatewayEndpoint` / `registerVpcInterfaceEndpoint`), simplify `BlocksVpcOptions` to `{ vpc, subnets?, provisionEndpoints? }`, and strip persistent test VPC to bare minimum.
