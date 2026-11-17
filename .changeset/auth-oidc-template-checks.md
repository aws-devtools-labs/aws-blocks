---
"@aws-blocks/create-blocks-app": patch
---

The `auth-oidc` template now ships a favicon, its cdk watch ignores the generated `aws-blocks/client.js`, and its e2e test runs against a deployed app when you set `TEST_URL`, calling the dev server it starts or reuses otherwise, never a URL a deploy recorded.
