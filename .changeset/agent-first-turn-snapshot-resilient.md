---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): a deployed Agent's first turn starts fresh when the session snapshot cannot be read

A brand-new conversation has no session snapshot. The deployed `S3Storage` only
treats `NoSuchKey`/`NoSuchBucket` as "no snapshot" and rethrows every other
missing-object shape (a `NotFound`/HTTP 404, or — per the originating issue's
own source analysis — an `AccessDenied` S3 can return for a missing object, a
regional-endpoint edge, or a transient fault) as `SessionError`, which
previously crashed the whole first turn. The deployed snapshot storage is now
wrapped so BOTH pre-write READ paths (`loadSnapshot`, `loadManifest`) fall back
to a fresh session on ANY read error — a pre-write read that fails for any
reason means there is nothing to restore. The concrete error shape (the deepest
cause's `name`, `httpStatusCode`, `requestId`) is flattened out of the
non-enumerable `.cause` and logged at `error` level so a recurring real fault
stays visible; an unexpected (non-missing) shape is worded distinctly.
Write/delete/list paths are unchanged, so a real persistence failure still
surfaces. No public API change — `createDeployedSnapshotStorage` is internal and
gains a required `log: ChildLogger` parameter `(bucket, log, S3StorageImpl?)` so
the diagnostics route through bb-logger, and the new `ResilientSnapshotStorage`
wrapper is internal (not part of the package's public export surface).
