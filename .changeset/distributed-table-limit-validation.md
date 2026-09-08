---
"@aws-blocks/bb-distributed-table": patch
---

Reject invalid `query` and `scan` limits consistently before either the local mock or DynamoDB runtime reads data.
