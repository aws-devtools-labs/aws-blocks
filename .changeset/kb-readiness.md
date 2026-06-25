---
"@aws-blocks/bb-knowledge-base": minor
---

Add `isReady()` / `waitUntilReady()` ingestion-readiness API to KnowledgeBase.

Bedrock ingestion runs asynchronously after deploy, so during the warm-up window `retrieve()` returns an empty array even for queries that would later match — making "empty" ambiguous between "still warming up" and "ingested, no match". The new methods resolve that ambiguity:

- `isReady(): Promise<boolean>` — `true` once the data source's most recent ingestion job is `COMPLETE`; `false` while ingestion is pending. Both local-folder and imported `s3://` sources register a BB-managed data source, so both are tracked (the "no managed data source → ready" shortcut applies only to deployments predating this API, which have no data source id injected). Throws a typed `IngestionFailedException` (including `failureReasons`) if the latest job failed.
- `waitUntilReady(options?: { timeoutMs?: number; pollIntervalMs?: number; maxConsecutiveTransientErrors?: number; signal?: AbortSignal }): Promise<void>` — polls until ready (defaults: `timeoutMs` 300000, `pollIntervalMs` 5000, `maxConsecutiveTransientErrors` 3), throwing a typed `KnowledgeBaseTimeoutException` on timeout or propagating `IngestionFailedException` on a failed job. Up to `maxConsecutiveTransientErrors` *consecutive* transient control-plane errors are tolerated (the counter resets on a clean poll); terminal errors short-circuit immediately. Transient covers both throttling / transient network failures **and** a *not-yet-visible* knowledge base — during the post-deploy window the control plane can briefly return `ResourceNotFoundException` (the freshly-created KB/data source hasn't propagated yet), which is ridden out rather than treated as terminal; a *missing-KB config* error (`KB_ID` unset) stays terminal. The poll interval carries ±20% jitter (only the delay between polls varies, never the poll count or the deadline) so many KBs don't poll in lockstep. Pass an optional `signal` (`AbortSignal`) to cancel the wait — checked before each poll and during the inter-poll delay — which rejects with the signal's abort reason (default: a `DOMException` named `'AbortError'`).

Purely additive — `retrieve()` and all existing signatures are unchanged. The local mock reports ready immediately (no warm-up window in local dev).
