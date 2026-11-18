---
"aws-blocks-kotlin": patch
---

Raw routes, such as the OIDC sign-in routes, are resolved against the server URL cut at its first
path segment that is exactly `aws-blocks`. A host or a segment that only begins with `aws-blocks`
(`aws-blocks.example.com`, `/aws-blocks-staging/`) no longer cuts the URL short.
