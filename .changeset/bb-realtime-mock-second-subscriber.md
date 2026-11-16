---
"@aws-blocks/bb-realtime": patch
---

In local dev, a second subscriber to a channel that is already subscribed on the same connection now gets its `established` promise resolved. Before, only the first subscriber per channel was confirmed, so `await sub.established` on any later subscriber never settled. Each subscriber now sends its own subscribe request, as on AWS.
