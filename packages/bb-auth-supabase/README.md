# `@aws-blocks/bb-auth-supabase`

Supabase authentication for AWS Blocks. Gate Blocks API methods by validating
the caller's Supabase JWT, verified **locally** with [`jose`](https://github.com/panva/jose)
— no per-request round-trip to the Supabase auth server.

It implements the framework-agnostic `BlocksAuth` contract, so any Blocks API
handler can gate on it — an alternative to per-request token introspection.

## Install

```bash
npm install @aws-blocks/bb-auth-supabase
```

## Usage

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { AuthSupabase } from '@aws-blocks/bb-auth-supabase';

const scope = new Scope('my-app');

const auth = new AuthSupabase(scope, 'auth', {
  supabaseUrl: 'https://abcxyz.supabase.co',
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Public: no auth call.
  async listPublicPosts() {
    return db.posts.findPublished();
  },

  // Gated: throws 401 if the caller has no valid Supabase token.
  async createPost(input: NewPost) {
    const user = await auth.requireAuth(context);
    return db.posts.create({ ...input, authorId: user.userId });
  },
}));
```

The client sends the Supabase access token as a Bearer header. A small helper
is provided for the browser:

```typescript
import { supabaseAuthHeader } from '@aws-blocks/bb-auth-supabase';

const { data } = await supabase.auth.getSession();
await api.createPost(input, { headers: supabaseAuthHeader(data.session?.access_token) });
```

## API — implements `BlocksAuth`

- `requireAuth(context)` — returns the `SupabaseUser`; throws `ApiError` 401
  (`SessionExpiredException`) when unauthenticated.
- `checkAuth(context)` — `boolean`.
- `getCurrentUser(context)` — `SupabaseUser | null`.
- `requireRole(context, role)` — `requireAuth` + `role` claim check (403 on
  mismatch). Supabase's top-level `role` is usually `authenticated`; finer
  RBAC typically lives in `app_metadata`.

`SupabaseUser` extends the common `AuthUser` (`userId` = `sub`, `username` =
`email ?? phone ?? sub`) with `email`, `role`, `appMetadata`, `userMetadata`,
and the raw verified `claims`.

## Key eras (auto-detected per token)

| Supabase era | Signing | How it's verified |
|---|---|---|
| **New signing keys** | ES256 / RS256 (asymmetric) | Against the project JWKS at `<supabaseUrl>/auth/v1/.well-known/jwks.json`, fetched once and cached. **No secret needed.** |
| **Legacy** | HS256 (shared secret) | Against the project's JWT secret. In production the secret lives in an AppSetting (SSM SecureString) this block provisions; for local dev/tests pass `jwtSecret` inline. |

`iss`, `aud` (default `authenticated`), and `exp` are always enforced.

## Configuration

| Option | Required | Description |
|---|---|---|
| `supabaseUrl` | yes | `https://<ref>.supabase.co` |
| `audience` | no | Expected `aud`. Default `authenticated`. |
| `jwtSecret` | no | Inline HS256 secret for local/tests. Omit in production (uses AppSetting). |

## Scope

This block validates Supabase access tokens; it does not implement sign-in
UI flows (Supabase clients own those). See `DESIGN.md`.
