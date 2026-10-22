---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/bb-lambda-compute": patch
---

fix(core): cap the API Gateway integration at 29s and surface a missing alarm subscriber

Two right-sizing fixes to the production defaults a deployed Blocks app ships with.

- **API Gateway integration timeout is pinned to 29s.** The shared handler's function timeout is the async-work ceiling (up to 900s for SQS/AsyncJob invocations), but API Gateway cuts a REST request off at 29s regardless — so a synchronous client that waited out the function timeout got a 504 at API Gateway's silent default instead of a meaningful boundary. Every Lambda integration on the shared REST API now carries an explicit 29s timeout; the function timeout the async path depends on is unchanged. The `bb-lambda-compute` `memory`/`maxTimeoutSeconds` docs now explain that the generous defaults are sized for the shared async path and how to right-size an API-only compute.
- **Hosting monitoring warns at synth when it has no alarm subscriber.** When monitoring is enabled with no `monitoring.subscriptions`, the alarm topic can enter ALARM but deliver to no one. The construct now emits a loud synth warning (the topic ARN is still surfaced as a stack output to subscribe out-of-band) so the gap is visible at build time rather than discovered during an incident.
