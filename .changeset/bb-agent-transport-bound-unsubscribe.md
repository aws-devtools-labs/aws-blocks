---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): call the Realtime subscription's `unsubscribe` on its own receiver

`realtimeTransport` stored the subscription's `unsubscribe` method detached from its object and later called it unbound. A `subscribe` adapter that returns a class instance (or any object whose `unsubscribe` uses `this`) threw on cancel, so the subscription stayed attached and the chunk stream never closed. The method is now invoked on the subscription object.
