---
"@aws-blocks/bb-realtime": patch
---

A server-side subscriber (`getChannel(...).subscribe(handler)` or `realtime.subscribe(...)` in the backend) now runs its handler once per published message on AWS, as it already did locally. When the publish came from the subscriber's own process, the handler used to run twice: once through the in-process emitter and once through the subscriber's own WebSocket.
