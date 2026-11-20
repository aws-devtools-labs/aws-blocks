---
"@aws-cdk-blocks/core": patch
---

docs: corrected five statements. A production `allowedOrigins` entry is matched exactly and an invalid one fails synth (it is not a regex). The local port is 3001 in the templates without a frontend. JSON-RPC `params` that is neither an array nor an object, `null` included, fails with `-32602`. The `ApiUrl` output is `publicApiUrl`. IAM report statements have a `condition` field. The shared-account platform guide is now `SHARED-ACCOUNT.md`.
