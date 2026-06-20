---
"@aws-blocks/bb-event-bus": patch
"@aws-blocks/blocks": patch
"@aws-blocks/core": patch
---

feat(bb-event-bus): add EventBridge-backed pub/sub event bus block

New `EventBus` block for server-to-server publish/subscribe with fan-out: `publish(type, detail)` emits to a dedicated Amazon EventBridge bus, and each `on(type, handler)` (or `'*'`) provisions a rule targeting the shared Lambda, routed to the right handler via a deterministic subscription id shared between the CDK and runtime layers. Typed via `EventBus<TEvents>`, with an optional per-subscription Standard Schema for validation. Fills the gap between `AsyncJob` (1→1, SQS) and `Realtime` (server→client).

`@aws-blocks/blocks` re-exports the new block (`SubscribeOptions` re-exported as `EventSubscribeOptions` to avoid the `Realtime` clash) and adds it to the vendorize map. `@aws-blocks/core` regenerates `OFFICIAL_BB_NAMES` to include `EventBus`.
