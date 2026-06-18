# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- AsyncJob — the word count MUST run in a background job, not inline in the request handler. Expect `new AsyncJob(...)` and a real `job.submit(payload)` (returns `{ jobId }`) at enqueue time.
- KVStore — each submission's result and `processing`/`done` status is stored keyed by job id so it survives a reload. Expect `store.put(jobId, ...)` and `store.get(jobId)`.
