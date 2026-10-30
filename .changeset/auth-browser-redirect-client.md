---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': minor
---

A web frontend served from another origin than its API can now sign in with a federated provider. `createAuthClient()` from the new `@aws-blocks/bb-auth/browser-client` entry (also exported from `@aws-blocks/blocks/ui`) replaces `AuthOIDC`'s `getClient()` browser client:

```typescript
import { createAuthClient } from '@aws-blocks/bb-auth/browser-client';

const auth = createAuthClient({ baseUrl: 'https://api.example.com', redirectUri: 'https://app.example.com/return' });
await auth.signInWithRedirect({ provider: 'okta' });   // on the sign-in button
const result = await auth.handleSignInRedirect();     // on the return page
const session = await auth.fetchAuthSession();        // { signedIn, user? }
await auth.signOut();
```

It signs in through the block's existing routes with PKCE and a signed, CSRF-bound `state`. The provider returns to the block's own callback, which sends the one-time code only to a return page on an origin in `redirects.allowedRelayOrigins` (loopback `http://127.0.0.1` is always allowed, for local development). The session stays in the block's `HttpOnly` cookie: no token is stored in JavaScript or put in a URL. The method names follow Amplify JS v6; the user and the error names are the block's own.

Two additions to the block's routes back it, and change nothing for existing clients:

- `GET /aws-blocks/auth/session` returns the signed-in user (the same fields `getAuthState()` sends) or `401 NotAuthenticatedException`.
- `POST <signOutPath>?format=json` answers `200 { logoutUrl? }`. Without the parameter it still answers `204`, as the native SDKs expect.

See the README section "Frontend on a different origin" for the backend settings: `allowedRelayOrigins`, the stack's CORS allowlist, and `session.crossDomain` for different registrable domains.
