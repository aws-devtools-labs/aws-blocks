---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): `complete()` settles when the turn finished before it subscribed

`complete()` subscribed to the turn's Realtime channel only when it was called, after `stream()` had already dispatched the turn. A `done`, `error` or `interrupt` chunk published before that subscription reached the server was dropped, and `complete()` waited forever. On AWS a fast turn on the AgentCore Runtime could finish first, so an API method awaiting `complete()` timed out with a 504 and a background job could hang. Locally, any `await` between `stream()` and `complete()` caused the same hang.

Each turn now records its final chunk before publishing it: in memory locally, and on AWS as a small object under `bb-agent-turn-outcomes/` in the agent's session bucket, expired after a day by a new lifecycle rule. `complete()` checks that record once its subscription is established, so it no longer has to be called before the turn ends. The record is kept for a day on AWS, and locally for the most recent 1,000 turns. If recording fails, `complete()` falls back to the live chunk.

- Calling `complete()` again returns the same result. After `resume()` on the same channel, `complete()` waits for the resumed turn, as the headless approval loop in the README expects.
- `done`, `error` and `interrupt` chunks now carry an optional `dispatchId` naming the `stream()` or `resume()` call they end. `complete()` uses it so the paused turn's interrupt, arriving late, can't settle the wait for the resumed turn. Chunks are still routed by `type`. During a deploy, a runtime still on the previous version publishes chunks without the field, and `complete()` accepts those as before.
- Each new wait in `complete()` signs fresh channel credentials instead of reusing the handle `stream()` returned, so a resumed turn can still be observed after a long approval (the AWS channel token lasts an hour).
- When the channel can't be subscribed and the turn hasn't finished yet, `complete()` now rejects with the subscription error instead of waiting forever. Calling it again subscribes again.
- `complete()` still has no timeout, because a turn can run for hours. Inside an API method, bound the wait yourself: API Gateway ends a request after about 29 seconds.

On AWS every turn makes one extra S3 PUT before its final chunk, whether or not `complete()` is called.
