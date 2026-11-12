---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
"@aws-blocks/create-blocks-app": patch
---

docs(telemetry): state the retention periods in the first-run notice

The first-run telemetry notice printed by the CLI and `create-blocks-app`, and the `@aws-blocks/blocks` README, now say that the collection endpoint does not store your IP address, except in logs of requests that its firewall blocks, and that events are kept for up to 1 year and logs of all requests, blocked or not, for up to 10 years.
