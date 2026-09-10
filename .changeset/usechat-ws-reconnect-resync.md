---
"@aws-blocks/bb-agent": minor
---

useChat now survives a mid-turn Realtime WebSocket disconnect/reconnect and send-path failures.

Long-running agent turns (up to 8h on AgentCore) can outlive API Gateway's WebSocket limits (2h max connection, 10-min idle). Previously useChat subscribed once and assumed the socket stayed healthy for the whole turn, so a reconnect gap could swallow the `done` chunk and leave `loading` stuck true, and a rejected/timed-out send (e.g. a 504 cold dispatch) left the spinner hanging with an orphaned empty assistant bubble.

- The `subscribe` option now accepts an options object (`{ onMessage, onDisconnect?, onReconnect? }`) in addition to a bare handler — backward compatible.
- On reconnect, useChat re-syncs authoritative state from the database (`getConversation` to recover the final assistant text if the turn completed during the gap; `getPendingInterrupts` to recover a missed interrupt). If the turn is still running, loading is preserved and streaming resumes on the resubscribed channel.
- `sendMessage` and `respondToInterrupt` now reset `loading` and surface `onError` when the underlying RPC rejects, dropping any empty placeholder.
- A bounded failsafe clears `loading` if no terminal chunk arrives within a window after a reconnect, so the spinner can never hang indefinitely.
