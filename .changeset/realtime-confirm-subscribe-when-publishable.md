---
"@aws-blocks/bb-realtime": patch
---

Fix deployed Realtime subscriptions missing the first messages published right after `established` resolved. `publish()` finds subscribers through a DynamoDB global secondary index, which is updated shortly after the subscription is written, so a publish sent at once could find no subscriber and drop the message. The server now confirms a subscription once `publish()` can find it, or after at most about 3 seconds: if the index still doesn't show it, or the lookup fails (for example, read throttling), it confirms anyway and logs a warning, so `established` never waits longer than that.
