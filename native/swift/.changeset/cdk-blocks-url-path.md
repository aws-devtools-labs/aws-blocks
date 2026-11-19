---
"aws-blocks-swift": minor
---

Generated clients and the codegen defaults use the new `/cdk-blocks/api` and `/cdk-blocks/auth/*` paths. Raw routes and auth requests resolve against the API origin cut at a `cdk-blocks` or legacy `aws-blocks` path segment, so a server URL configured with the old `/aws-blocks/api` path keeps working.
