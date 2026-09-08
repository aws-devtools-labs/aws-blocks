---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(hosting): DeleteOldBuilds no longer expires the build that is currently served (#480)

The `DeleteOldBuilds` S3 lifecycle rule expired every object under `builds/`
after `buildRetentionDays` (default 30), including the build that CloudFront KVS
`meta.b` currently points to. An app that did not deploy within the retention
window had its live build's objects expired out from under an otherwise-healthy
stack — the router kept rewriting to the now-empty prefix, so every static path
returned 403 (hosting ≤ 0.1.4) or 404 (≥ 0.1.5) while the API path stayed 200.
Recovery required a redeploy.

**Fix.** The lifecycle rule now matches only objects tagged
`aws-blocks:build-state=superseded`. At the KVS cutover, after the pointer flips
to the new build, the cutover handler tags the *outgoing* build's objects
superseded (best-effort; list + tag/untag only — the handler is granted **no** S3
delete-object permission). The live build is never tagged, so it is never expired,
regardless of deploy cadence. Superseded builds are still cleaned up after
`buildRetentionDays`. S3 lifecycle `TagFilters` are inclusion-only (there is no
"NOT tagged" predicate), which is why the superseded build is tagged rather than
the live build excluded.

**Rollback-safety hardening.** The same cutover also *clears* the build-state tag
on the *incoming* build's objects, symmetric to tagging the outgoing one. Without
this, a rollback that re-points `meta.b` back to a retained build that was tagged
superseded by an earlier cutover would hand the now-live build to
`DeleteOldBuilds` — #480 again. Clearing is best-effort and uses
`s3:DeleteObjectTagging` (tags only, never objects).

**`buildRetentionDays` is now configurable from `@aws-blocks/core`.** Previously
`HostingProps` dropped it (only `retainOnDelete` was forwarded), so the only way
to change retention was an L1 bucket override. It now flows through to the
hosting bucket lifecycle rule. Must be at least `skewProtection.maxAge`
(converted to days) or synth throws `InvalidSkewProtectionMaxAgeError`, as
before.

**New advisory guard.** An optional `storage.deployIntervalDays` hint emits a
synth-time **warning** (never an error) when the deploy cadence is at or beyond
`buildRetentionDays`, i.e. when superseded builds could age out before the next
deploy and shrink the rollback window. The live build is unaffected, so this is
a rollback-window note, not a correctness gate.

Pre-1.0 `minor` per this repo's convention: the change alters the synthesized
lifecycle rule and the `KvKeys` custom resource (a benign in-place bucket-config
+ Lambda-role update on the next deploy; no bucket replacement), and adds a new
IAM grant (`s3:ListBucket` + `s3:PutObjectTagging` + `s3:DeleteObjectTagging`,
scoped to `builds/*`) to the
cutover handler. Build artifacts uploaded before the upgrade carry no
`build-state` tag and are therefore never expired by the new rule — including
the live build — so the upgrade cannot delete a running build; from the next
deploy onward each superseded build is tagged and reclaimed normally.
