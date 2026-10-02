---
"@aws-blocks/bb-realtime": patch
---

fix(bb-realtime): validate publish size against the 128 KiB message quota, not the 32 KiB frame quota

`publish` rejected payloads above 32 KiB, API Gateway's WebSocket *frame* size — but a
message is reassembled from multiple frames, so the real limit is the 128 KiB message
quota. Messages between 32 KiB and 128 KiB were refused client-side even though API
Gateway would have delivered them. The serialized envelope is now checked against
131,072 bytes: 131,072 is accepted and 131,073 is rejected.
