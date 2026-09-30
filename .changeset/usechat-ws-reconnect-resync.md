---
"@aws-blocks/bb-agent": minor
---

`createChat`/`realtimeTransport` (and `useChat`) now survive a mid-turn Realtime WebSocket disconnect/reconnect and send-path failures.

Long-running agent turns (up to 8h on AgentCore) can outlive API Gateway's WebSocket limits (2h max connection, 10-min idle). Previously the client subscribed once and assumed the socket stayed healthy for the whole turn, so a reconnect gap could swallow the `done` chunk and leave `loading` stuck true, and a rejected/timed-out send (e.g. a 504 cold dispatch) left the spinner hanging with an orphaned empty assistant bubble. `createChat` is the preferred client API; `realtimeTransport` forwards the reconnect callbacks to the channel automatically, so the standard wiring is reconnect-safe with no extra app code. `useChat` (deprecated) retains the same behavior.

- On reconnect, the client re-syncs authoritative state from the database (`getConversation` to recover the final assistant text if the turn completed during the gap; `getPendingInterrupts` to recover a missed interrupt). If the turn is still running, loading is preserved and streaming resumes on the resubscribed channel.
- `sendMessage` / `respondToInterrupt` (and the `run`/`resume` send path) now reset `loading` and surface `onError` when the underlying RPC rejects, dropping any empty placeholder.
- A bounded failsafe clears `loading` if no terminal chunk arrives within a window after a reconnect, so the spinner can never hang indefinitely.
- The `subscribe` seam accepts an options object (`{ onMessage, onDisconnect?, onReconnect? }`) in addition to a bare handler — backward compatible.
