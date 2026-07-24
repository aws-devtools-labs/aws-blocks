# `@aws-blocks/bb-auth-supabase` — Design Notes

Implementation notes. Customer-facing docs live in `README.md`.

## Motivation

A common pattern for authenticating Supabase-backed apps is per-app,
framework-specific middleware that introspects the caller's token on every
request. This block offers the same capability as a first-class,
framework-agnostic Building Block behind the `BlocksAuth` contract — any
`ApiNamespace` / `bb-data` Lambda handler gates on it with
`await auth.requireAuth(context)` — and verifies the token locally to avoid a
per-request round-trip.

## Local verification, both key eras

`createSupabaseVerifier` (see `verify.ts`) validates tokens **locally** with
`jose` and auto-detects the signing algorithm from the JWT protected header:

- `HS*` → symmetric verify against the project JWT secret (legacy
  shared-secret era).
- `ES*` / `RS*` → verify against the project JWKS via `createRemoteJWKSet`
  (Supabase's asymmetric signing keys). The JWKS is fetched once per process
  and cached; `jose` re-fetches on an unknown `kid` to survive key rotation.

Verifying locally removes the per-request dependency on Supabase's auth
server for the symmetric case and standardizes both eras behind one call.
`iss` (`<supabaseUrl>/auth/v1`), `aud`, and `exp` are always enforced.

## Statelessness

Supabase access tokens are self-contained JWTs, so — unlike session-based
blocks (`bb-auth-basic`, `bb-auth-oidc`) — this block provisions **no** KVStore
session table and sets **no** cookies. The only infrastructure is an optional
`AppSetting` (SSM SecureString) for the legacy HS256 secret; asymmetric-only
projects provision nothing beyond the block scope.

## Secret handling

- Production: `new AppSetting(this, 'jwt-secret', { secret: true })`, resolved
  lazily at runtime via `.get()` and cached inside the verifier closure.
- Local/tests: an inline `jwtSecret` option bypasses AppSetting so the block
  runs fully offline (the mock AppSetting returns a random placeholder for an
  unset secret, which would not match a caller-minted token).

## Testing

- `verify.test.ts` exercises the pure verifier: HS256 happy-path + negatives
  (wrong secret, foreign issuer, wrong audience, expiry, missing-secret,
  malformed), and the ES256/JWKS path against an in-process JWKS server bound
  to `127.0.0.1` (valid token accepted, foreign-key token rejected).
- `index.test.ts` drives the `BlocksAuth` surface against a fake
  `BlocksContext`: `requireAuth`/`checkAuth`/`getCurrentUser`/`requireRole`,
  including the 401 and 403 error identities.

## Scope

This block validates Supabase access tokens and exposes the resulting user
via `BlocksAuth`. It does not implement sign-in / sign-up flows — Supabase
clients own those; the block only validates the tokens they issue.
