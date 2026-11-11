---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-realtime": patch
---

refactor: move the conversation, message, job-status and connection tables to `KVStore` with a declared key

`Agent`, `AsyncJob` and `Realtime` now compose `KVStore` from `@aws-blocks/bb-kv-store` instead of `DistributedTable`. The tables keep their names, key schemas, TTL attributes and items, so a deployed stack updates in place. No public API of these blocks changes. Expired job-status records and connection records are now hidden from every read in both runtimes.
