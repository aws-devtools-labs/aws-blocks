---
"@aws-blocks/bb-auth-jwt": minor
---

Add `AuthBearerJwt`, a provider-agnostic bearer-JWT Building Block. It validates a request's `Authorization: Bearer` token against a configured issuer and JWKS, then exposes the verified user to any API-namespace handler via `requireAuth(context)`. Configuration is generic (issuer + JWKS URL/map, optional audience, required claims, subject claim); asymmetric signing (RS256/ES256) is the default and HS256 is opt-in via `hmacSecret`. A `./mock` entry point (`createLocalJwt`) provides an in-memory ES256 keypair + local JWKS and a `mint()` helper for network-free local development and tests.
