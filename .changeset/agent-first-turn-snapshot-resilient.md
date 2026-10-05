---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

fix(bb-agent): a deployed Agent's first turn starts fresh when no session snapshot exists yet

A brand-new conversation has no session snapshot. The deployed `S3Storage` only
treats `NoSuchKey`/`NoSuchBucket` as "no snapshot" and rethrows a missing object
that surfaces as `NotFound`/HTTP 404 as `SessionError`, which previously crashed
the whole first turn. The deployed snapshot storage is now wrapped so a MISSING
(404) first-turn read falls back to a fresh session and logs the cause. The
fallback is narrow: a non-404 fault (a `403 AccessDenied` permission gap, a
transient `5xx`/throttle, a corrupt-snapshot parse error) is rethrown, so an
established conversation's persisted state is never silently discarded, and
write/delete paths are unchanged, so a real persistence failure still surfaces.
No API change — `createDeployedSnapshotStorage`'s signature is unchanged, and
the new `ResilientSnapshotStorage` wrapper is internal (not part of the
package's public export surface).
