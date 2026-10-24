---
"@aws-blocks/core": patch
"@aws-blocks/hosting": patch
"@aws-blocks/bb-lambda-compute": patch
---

fix(core): make the API Gateway 29s integration default explicit and warn on an undeliverable alarm topic

Two right-sizing fixes to the production defaults a deployed Blocks app ships with.

- **API Gateway integration timeout is set explicitly to 29s.** `LambdaIntegration` already defaults to 29s, so this is no runtime change — it writes the boundary into the synthesized template (an explicit `TimeoutInMillis: 29000` on each Lambda method) so it is visible at review and aligned with the handler's own 28s deadline guard (`APIGW_TIMEOUT_MS`), which already emits a structured 504 just before the cut-off. A request still in flight at 29s is cut off by API Gateway regardless of how long the Lambda may run; the shared handler's function timeout (up to 900s) is the async-work ceiling and is unreachable on the synchronous HTTP path. The `bb-lambda-compute` `memory`/`maxTimeoutSeconds` docs now explain that the generous defaults are sized for the shared async path and how to right-size an API-only compute.
- **Hosting monitoring warns at synth when the alarm topic has no subscriber.** When monitoring is enabled and the alarm topic ends up with no subscriber, it can enter ALARM but deliver to no one. The construct now emits a loud synth warning — deferred to a validation so it accounts for subscriptions added after construction (via `monitoring.alarms` / `monitoring.alarmTopics` or a direct `topic.addSubscription`), and gated on at least one alarm existing. The message names the `acknowledgeWarning` escape hatch for callers who accept the gap knowingly.
