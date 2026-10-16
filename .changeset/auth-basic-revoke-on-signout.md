---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

AuthBasic now revokes the session token server-side on sign-out. Each session
JWT carries a unique `jti`; `signOut` records that id on a revocation list (in
the existing codes store, expiring with the token) so a replayed cookie is
rejected even though the JWT is still unexpired and signature-valid. The
umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
README/DESIGN docs it mirrors have changed.

Operator note: the `codes` store gains `{ ttl: true }`. For an already-deployed
AuthBasic app this is an in-place DynamoDB TimeToLive enablement (an `UpdateTable`)
on the next `cdk deploy` — no data migration, and correctness does not depend on
the reaper (reads filter expired items regardless).
