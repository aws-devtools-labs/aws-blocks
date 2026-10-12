---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/bb-lambda-compute": patch
---

Document the shared API gateway. The `@aws-blocks/core` README gains a "Shared API gateway" section covering how every path reaches the backend, per-namespace routes, default throttling, opt-in access logs (with the matched `routeKey`), the 30-second / 10 MB limits, and enabling WAF on CloudFront through Hosting. The `bb-lambda-compute` design notes now describe the multi-compute routing: `$default` goes to the default compute, and per-namespace routes go to the others.
