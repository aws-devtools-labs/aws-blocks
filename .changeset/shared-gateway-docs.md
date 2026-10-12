---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/bb-lambda-compute": patch
---

Document the shared API gateway. The `@aws-blocks/core` README gains a "Shared API gateway" section covering how every path reaches the backend, per-namespace paths, default throttling, opt-in access logs, the 29-second / 10 MB limits, and attaching WAF to the gateway stage or to Hosting's CloudFront distribution. The `bb-lambda-compute` design notes now describe the multi-compute routing: catch-all resources go to the default compute, and per-namespace resources go to the others.
