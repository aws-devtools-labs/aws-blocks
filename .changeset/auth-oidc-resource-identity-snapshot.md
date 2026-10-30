---
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/blocks": patch
---

Internal: test coverage pinning deployed resource identity. A snapshot test records the CloudFormation identity of the resources `AuthOIDC` deploys in direct and `cognitoFederated()` modes. No runtime or infrastructure change.
