---
"@aws-blocks/bb-agent": minor
---

feat(bb-agent): compute-agnostic client streaming API — `createChat` + `realtimeTransport`

Adds a redesigned client streaming surface that hides the runtime behind a single
transport seam, so the same frontend code works across runtimes:

- `createChat({ transport, api })` — the client API. The common case is one call
  (`chat.sendMessage('Hello')`); subscribe and run are fused so the
  subscribe-before-send race can't surface. The flexible primitives `run()`
  (produce) and `subscribe()` (consume) are exposed for fan-out, observer-only
  attach, and decoupled produce/consume.
- `realtimeTransport(...)` — the Lambda + Realtime implementation of the
  `ChatTransport` seam. Configure it once; call sites never name the runtime. A
  future runtime supplies a different transport; nothing else on the client changes.

Additive and non-breaking. The `stream()` / `getChannel()` / `resume()` server
methods are unchanged (the new transport is built on them). Only the `useChat`
client hook is now marked `@deprecated`, superseded by `createChat`.
