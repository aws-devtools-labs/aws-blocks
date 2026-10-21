---
"@aws-blocks/bb-auth-basic": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/blocks": patch
---

AuthBasic now revokes the session token server-side on sign-out. Each session
JWT carries a unique `jti`; `signOut` records that id on a revocation list (in
the existing codes store, expiring with the token) so a replayed cookie is
rejected even though the JWT is still unexpired and signature-valid. The
umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
README/DESIGN docs it mirrors have changed.

This is a `minor` (not `patch`) bump because it adds exported error constants —
`AuthBasicErrors.SessionRevoked` (`SessionRevokedException`, thrown by
`requireAuth` for a signed-out/revoked session, vs `SessionExpiredException` for
an absent/aged-out one) and `AuthBasicErrors.SignOutIncomplete`
(`SignOutIncompleteException`, 503, thrown when the revocation write fails) —
and documents a new throwable name on the shared `BlocksAuth.requireAuth`
contract in `@aws-blocks/auth-common`.

`signOut` always clears the local cookie (so sign-out on this device never
leaves the user stuck signed in), even when the server-side revocation write
fails; in that case it throws a stable `SignOutIncompleteException` rather than
the raw SDK error, so no `$metadata`/ARNs leak to the client.

Legacy-surface behavior change: the deprecated `buildApi().signOut` previously
always resolved to `{ success: true }`; it now awaits `signOut` and so can
reject with `SignOutIncompleteException` (503) when the revocation write fails.
Only direct `buildApi` callers are affected — the `createApi()` state machine
catches it into the `AuthState.error` field.

Operator note: the `codes` store gains `{ ttl: true }`. For an already-deployed
AuthBasic app this is an in-place DynamoDB TimeToLive enablement (an `UpdateTable`)
on the next `cdk deploy` — no data migration, and correctness does not depend on
the reaper (reads filter expired items regardless). Caveat: DynamoDB rejects
another `UpdateTimeToLive` on the same table for ~1 hour after a change, so if an
unrelated resource fails in the same deploy, CloudFormation rollback (which
disables TTL) — or a deploy → rollback → redeploy within that hour — can land in
`UPDATE_ROLLBACK_FAILED`. Deploy AuthBasic apps with this in mind.
