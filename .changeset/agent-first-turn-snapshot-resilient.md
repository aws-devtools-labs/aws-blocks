---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): capture the concrete S3 error shape when a deployed Agent's session snapshot cannot be read

A brand-new conversation has no session snapshot; `S3Storage` already returns
`NoSuchKey`/`NoSuchBucket` as `null` (and a missing manifest as empty), which
Strands' `SessionManager` treats as "start fresh", so a genuine first turn is
not affected. When a snapshot read fails for some OTHER reason — `AccessDenied`,
a 5xx, a corrupt object — the error now carries actionable diagnostics: the
deepest cause's `name`, `httpStatusCode` and `requestId` are flattened out of
the non-enumerable `.cause` (which `bb-logger` otherwise never serializes) and
logged at `error` level by `runAgent`, so the concrete production error shape is
recorded for the first time instead of only the opaque `S3 error reading <key>`
message.

The read paths deliberately still RETHROW a non-missing fault rather than
starting fresh: `SessionManager` overwrites `snapshot_latest.json` after a fresh
start, so swallowing a transient read fault would silently overwrite an
established conversation's saved history with a blank one. Surfacing the error
(and now capturing its shape) is the correct behaviour. No public API change —
`createDeployedSnapshotStorage` is internal and gains a `log: ChildLogger`
parameter `(bucket, log, S3StorageImpl?)` so the logger is threaded to the
storage seam.
