---
"@aws-blocks/bb-knowledge-base": patch
---

Make the local `waitUntilSynced()` mock reject with an already-aborted `AbortSignal`, matching the AWS runtime cancellation contract.
