# DESIGN — `@aws-blocks/bb-auth-jwt`

## Motivation

A common pattern for authenticating apps backed by a third-party identity
provider is per-app, framework-specific middleware that introspects the caller's
token on every request. This block offers the same capability as a first-class,
framework-agnostic Building Block behind the `BlocksAuth` contract, verifying the
token locally against the issuer's JWKS with no per-request round-trip.

## Position relative to AuthOIDC

`AuthOIDC` is a login-flow block: it owns the OAuth2/OIDC authorization-code flow
and issues server-side sessions. `AuthBearerJwt` is its stateless counterpart:
the identity provider's own client SDK owns sign-in and token lifecycle, and this
block only verifies the resulting bearer token. Both satisfy `BlocksAuth`, so
they are interchangeable at the call site.

## Verification

1. Extract the `Bearer` token from the `Authorization` header.
2. Reject any algorithm outside the allowlist (asymmetric RS*/ES* by default;
   HS256 only when `hmacSecret` is explicitly configured; `alg: none` always rejected).
3. Verify signature + `iss` (+ `aud` when configured) + `exp`/`iat`/`nbf` via `jose`,
   using keys fixed from config (never derived from the token).
4. Enforce `requiredClaims`.
5. Map claims to `{ userId, username, claims }`.

The key source is one of: a single JWKS URL, a per-issuer JWKS map, an injected
resolver (local-dev mock), or an HS256 shared secret.

## RLS

The block returns the full verified `claims`; the RLS lift happens where the data
layer runs it — `db.withRLS({ userId, claims })`. The block does not depend on
the data package, keeping "verify" and "RLS forwarding" decoupled.

## Security properties

- `iss`/`aud` validated; key source never taken from the token.
- Algorithm allowlist; HS256 opt-in only; `alg: none` rejected.
- JWKS cache bounds the window a rotated/compromised key stays trusted.
- Stateless: no session store, no infrastructure.

## Token revocation

Verification is local, so a revoked token remains valid until `exp`. Use short
token TTLs, or a per-request check against the issuer for sub-minute needs.

## Scope

No sign-in flows, sessions, token issuance, or provider-specific naming — those
belong to the identity provider's client SDK or a provider-specific wrapper.
