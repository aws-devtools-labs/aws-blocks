---
"@aws-blocks/core": minor
---

Add default throttling and structured access logging to the central API Gateway. The stage now enforces a steady-state limit of 100 requests/second with a burst ceiling of 200 (returning 429s beyond that), and emits JSON access logs (IP, method, resource path, status, response length, request time, caller, user, protocol) to a dedicated CloudWatch `ApiAccessLogs` log group with 1-month retention (`RemovalPolicy.DESTROY` so stack teardown stays clean). These are account-level stage defaults and can be overridden per-method if needed.
