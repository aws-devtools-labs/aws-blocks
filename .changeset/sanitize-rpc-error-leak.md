---
"@aws-blocks/core": patch
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-app-setting": patch
"@aws-blocks/bb-async-job": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/bb-cron-job": patch
"@aws-blocks/bb-dashboard": patch
"@aws-blocks/bb-distributed-table": patch
"@aws-blocks/bb-email-client": patch
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/bb-kv-store": patch
"@aws-blocks/bb-metrics": patch
---

Stop leaking raw backend exception details in RPC error responses without dropping Building Block error names.

`errorResponseFromCatch` now sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `name`, `retriable`); a Building Block error carrying the wire-safe brand forwards its BB `name` in `data.name` but drops the raw message (a generic `500` / `"Internal error"`), so `isBlocksError()` keeps matching on the client per D-003; and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500`. The full error is still logged server-side in every case.

The brand is a non-enumerable symbol stamped by core's new `brandBlocksError()` helper, and the serializer keys the name-forwarding decision on that brand rather than on `.name !== 'Error'`. Every Building Block that mints a named error now routes it through that one helper — core's `blocksError()`, each package's own local `blocksError()`, and the inline named-error sites in `bb-agent`, `bb-async-job`, `bb-auth-oidc` and `bb-cron-job` — so a BB error keeps its `name` on the wire no matter which package threw it. A raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is never branded, so its class name still never reaches the client.

Scope: `bb-data`'s conflict paths already cross the wire as `ApiError` (409) and are unaffected. `bb-data`'s catch-all re-tag path (`wrapError` / `translatePgError` setting `.name` to `QueryFailed`/`ConnectionFailed` on a caught driver object) is not branded here; it mutates a caught exception rather than minting a fresh BB error, so it is left for a separate change.
