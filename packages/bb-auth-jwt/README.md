# `@aws-blocks/bb-auth-jwt`

Provider-agnostic stateless bearer-JWT authentication Building Block. Verifies an
externally-issued JWT (the identity provider's own client SDK owns sign-in and
token lifecycle) against a configured issuer + JWKS, then surfaces the verified
claims for RLS via `db.withRLS({ userId, claims })`.

Sibling to `@aws-blocks/bb-auth-oidc`: OIDC owns interactive sign-in and server
sessions; this block statelessly verifies tokens minted elsewhere.

```typescript
import { AuthBearerJwt } from '@aws-blocks/bb-auth-jwt';

const auth = new AuthBearerJwt(scope, 'auth', {
  issuer: 'https://issuer.example.com',
  jwks:   'https://issuer.example.com/.well-known/jwks.json',
  audience: 'my-api',
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async listTodos() {
    const user = await auth.requireAuth(context);
    return db.withRLS({ userId: user.userId, claims: user.claims })
      .query(sql`SELECT * FROM todos`);
  },
}));
```

## Options

- `issuer` — expected `iss` (one or several).
- `jwks` — JWKS URL, per-issuer `{ [iss]: uri }` map, or an injected resolver.
- `hmacSecret` — opt-in HS256 (asymmetric JWKS is the default; HS256 is never silently accepted).
- `audience`, `requiredClaims`, `subjectClaim`, `mapUser`, `jwksCacheMaxAge`, `clockTolerance`.

## Local development

`@aws-blocks/bb-auth-jwt/mock` exports `createLocalJwt()` — an in-process ES256
key + local JWKS + `mint()` helper, so backends verify tokens fully offline with
no real issuer.

## Scope

Validates access tokens and exposes the resulting user via `BlocksAuth`. It does
not implement sign-in flows, sessions, or token issuance — those belong to the
identity provider's client SDK.
