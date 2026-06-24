---
"@aws-blocks/bb-knowledge-base": minor
---

Add `isReady()` / `waitUntilReady()` ingestion-readiness API to KnowledgeBase.

Bedrock ingestion runs asynchronously after deploy, so during the warm-up window `retrieve()` returns an empty array even for queries that would later match — making "empty" ambiguous between "still warming up" and "ingested, no match". The new methods resolve that ambiguity:

- `isReady(): Promise<boolean>` — `true` once the data source's most recent ingestion job is `COMPLETE` (or when there is no BB-managed data source to track, e.g. an imported `s3://` source); `false` while ingestion is pending. Throws a typed `IngestionFailedException` (including `failureReasons`) if the latest job failed.
- `waitUntilReady(options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<void>` — polls until ready (defaults: `timeoutMs` 300000, `pollIntervalMs` 5000), throwing a typed `KnowledgeBaseTimeoutException` on timeout or propagating `IngestionFailedException` on a failed job.

Purely additive — `retrieve()` and all existing signatures are unchanged. The local mock reports ready immediately (no warm-up window in local dev).
