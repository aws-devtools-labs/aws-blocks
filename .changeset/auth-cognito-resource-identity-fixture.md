---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

Internal: test coverage pinning deployed resource identity. A new golden-fixture test locks the CloudFormation identity of every resource `AuthCognito` deploys (user pool, app client, groups, session table and session secret), its config keys and its session cookie name, so a future change can't silently replace a deployed user pool. No runtime or infrastructure change.
