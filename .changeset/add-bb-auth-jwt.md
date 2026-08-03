---
"@aws-blocks/bb-auth-jwt": minor
"@aws-blocks/blocks": patch
"@aws-blocks/core": patch
---

Add `AuthBearerJwt`, a provider-agnostic bearer-JWT Building Block. It validates a request's `Authorization: Bearer` token against a configured issuer and JWKS, then exposes the verified user to any API-namespace handler via `requireAuth(context)`. Configuration is generic (issuer + JWKS URL/map, optional audience, required claims, subject claim); asymmetric signing (RS256/ES256) is the default and HS256 is opt-in via `hmacSecret`. A `./mock` entry point (`createLocalJwt`) provides an in-memory ES256 keypair + local JWKS and a `mint()` helper for network-free local development and tests.

The `@aws-blocks/blocks` umbrella package receives a `patch` because it now re-exports `AuthBearerJwt` (and its error/type surface) from `@aws-blocks/bb-auth-jwt`. Sibling patch/minor releases stay inside the umbrella's caret range, so `changeset version` would not bump it on its own (#212); it is declared explicitly so it republishes in step with the block it hands to consumers.

The umbrella also registers the block in its `aws-blocks.vendorize` map (`AuthBearerJwt`), so `blocks-vendorize AuthBearerJwt` resolves it by Building Block name like every other block. `@aws-blocks/core` receives a `patch` because that map is the source for `OFFICIAL_BB_NAMES` (generated into `packages/core` by `scripts/generate-bb-names.mjs`), which telemetry consults to decide which blocks it may name.
