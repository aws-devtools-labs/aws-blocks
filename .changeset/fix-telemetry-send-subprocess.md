---
"@aws-blocks/core": patch
---

fix(telemetry): send events via detached subprocess to prevent dropped events

Telemetry events are now sent via a detached background subprocess instead of
an in-process https.request. This ensures events are delivered even when the
parent CLI process exits on failure paths before the socket flushes.
