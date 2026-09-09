---
"@aws-blocks/core": patch
"@aws-blocks/bb-realtime": patch
"@aws-blocks/blocks": patch
---

Local dev server: handle raw-socket errors during the WebSocket upgrade instead of crashing.

The `upgrade` handlers routed the HTTP upgrade without attaching an `'error'` listener to the raw `net.Socket` first. A stale WebSocket client that reset its connection inside the upgrade window emitted ECONNRESET on a socket with no handler, so Node's default unhandled-`'error'` behaviour killed the dev server process right after port bind. Both upgrade paths now attach `socket.on('error', () => socket.destroy())` as their first statement, the HTTP server answers malformed/aborted requests via a `clientError` handler, and the `noServer` `WebSocketServer` logs server-level errors rather than throwing. The fix is scoped to the vulnerable socket — a genuine error anywhere else still crashes as before.
