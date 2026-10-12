---
"@aws-blocks/blocks": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/core": patch
---

Update docs for the shared HTTP API gateway: deployed `apiUrl` examples no longer show a `/prod` stage segment, `RawRoute` docs describe the gateway's `$default` catch-all route, the security checklist notes that AWS WAF attaches to a CloudFront distribution in front of the HTTP API (not the API itself), and the `accessLogging` / `throttling` defaults docs no longer describe the backend API as a REST API that needs the account-level CloudWatch Logs role.
