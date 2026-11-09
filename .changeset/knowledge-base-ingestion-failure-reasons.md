---
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/blocks": patch
---

fix(bb-knowledge-base): keep raw ingestion failure text out of client errors

When the latest ingestion job had failed, `isSynced()` and `waitUntilSynced()` threw `IngestionFailedException` with Bedrock's `failureReasons` in the message. That message is returned to RPC callers, and the reasons are raw service text that can name buckets, object keys or ARNs. The error now has a fixed message. The reasons are written to the server log and kept on the error's non-enumerable `cause` (`err.cause.failureReasons`), so `JSON.stringify(err)` and the RPC response leave them out. The error name, `KnowledgeBaseErrors.IngestionFailed` and the method signatures are unchanged. If your server code read the reasons from `err.message`, read `err.cause.failureReasons` instead.
