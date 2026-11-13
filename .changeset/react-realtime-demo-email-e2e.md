---
"@aws-blocks/create-blocks-app": patch
---

The `react` template's e2e now checks that creating, reprioritizing and deleting a todo each reach a live Realtime subscriber. The `demo` template's EmailClient e2e now checks the sent mail's recipient, sender, subject and body in the local outbox, and that an invalid address is rejected.
