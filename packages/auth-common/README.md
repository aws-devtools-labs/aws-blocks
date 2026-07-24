# @aws-blocks/auth-common

Shared interfaces and UI components for all AWS Blocks auth Building Blocks. Use this package to build provider-agnostic auth UI, or import the types when authoring a custom auth Building Block.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Exports

| Export Path | What it provides |
|---|---|
| `@aws-blocks/auth-common` | Types: `BlocksAuth`, `AuthUser`, `AuthState`, `AuthAction`, `AuthField` |
| `@aws-blocks/auth-common/ui` | Components: `AccountMenuBar`, `Authenticator`, `AuthenticatedContent`, `onAuthChange`, `broadcastAuthChange`, `submitAuthAction` |
| `@aws-blocks/auth-common/cookies` | Shared session-cookie security policy: `resolveCookieSecurity`, `buildCookieSecurityAttrs`, `isLoopbackRequest` |

## Session-cookie security policy (`/cookies`)

All AWS Blocks auth BBs route their session-cookie `SameSite` / `Secure` / `Partitioned` selection through this one helper, so they converge structurally instead of drifting. Given `{ crossDomain, isLocalhost }` it returns the canonical attributes:

| `crossDomain` | `isLocalhost` | attributes |
|---|---|---|
| `false` (default) | `false` | `SameSite=Lax; Secure` |
| `false` | `true` | `SameSite=Lax` |
| `true` | `false` | `SameSite=None; Secure; Partitioned` |
| `true` | `true` | `SameSite=None; Secure` |

`buildCookieSecurityAttrs(input)` returns the string form for BBs that assemble `Set-Cookie` by hand; `resolveCookieSecurity(input)` returns the attribute object for BBs that pass a structured cookie config. `isLoopbackRequest(ctx)` detects loopback origins (`localhost`, `127.0.0.1`, `[::1]`) for per-request `isLocalhost` decisions.


## Server-Side Interface (`BlocksAuth`)

All auth BBs implement `BlocksAuth`. Server-side code is identical regardless of provider:

```typescript
import { AuthBasic } from '@aws-blocks/bb-auth-basic';

const auth = new AuthBasic(scope, 'auth');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Require auth — throws 401 if not signed in
  async getProfile() {
    const user = await auth.requireAuth(context);
    return { username: user.username };
  },

  // Optional auth — returns null if not signed in
  async getContent() {
    const user = await auth.getCurrentUser(context);
    return user ? `Hello ${user.username}` : 'Hello guest';
  },

  // Boolean check — for branching
  async isLoggedIn() {
    return await auth.checkAuth(context);
  },
}));

// Export the state machine API for the Authenticator component
export const authApi = auth.createApi();
```

| Method | Returns | When to use |
|---|---|---|
| `requireAuth(context)` | `Promise<AuthUser>` | Protected endpoints. Throws 401 if not signed in. |
| `checkAuth(context)` | `Promise<boolean>` | Branching logic. |
| `getCurrentUser(context)` | `Promise<AuthUser \| null>` | Optional personalization. |

## Authenticator Component

The `Authenticator` renders auth UI driven by the state machine. It works with any auth provider — `AuthBasic`, `AuthOIDC`, `AuthCognito` — because it renders based on `AuthState`, not provider-specific logic.

```typescript
import { Authenticator } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi));
```

To restyle, relabel, hide, or fully replace the rendered forms, see
[Customizing Auth UI](./CUSTOMIZING-AUTH-UI.md).

The component:
- Calls `getAuthState()` on mount to determine what to render
- Renders form fields and submit buttons for each available action
- For internal actions (no `url`): collects input and calls `setAuthState({ action, ...fields })`
- For external actions (with `url`): renders an HTML form that submits to the external URL (OAuth/OIDC)
- Broadcasts auth changes to other tabs/windows and re-renders when changes arrive

## AccountMenuBar

Compact bar for the top of the page. Shows "👤 username | Sign Out" when signed in, or a "Sign In" button when signed out. Clicking "Sign In" opens the `Authenticator` in a modal overlay.

```typescript
import { AccountMenuBar } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.prepend(AccountMenuBar(authApi));
```

Use `AccountMenuBar` for the page header and `Authenticator` when you want a standalone sign-in form (e.g., a dedicated login page).

## AuthenticatedContent

Renders content only when the user is signed in. Automatically updates when auth state changes (same window and cross-tab).

```typescript
import { AuthenticatedContent } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(
  AuthenticatedContent(authApi, (user) => {
    const el = document.createElement('div');
    el.textContent = `Welcome, ${user.username}`;
    return el;
  })
);
```

## Auth State Change Subscription

Subscribe to auth state changes from any source (same window + other tabs):

```typescript
import { onAuthChange } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

const unsubscribe = onAuthChange(authApi, (user) => {
  if (user) {
    console.log('Signed in:', user.username);
  } else {
    console.log('Signed out');
  }
});

// Later: unsubscribe();
```

`onAuthChange` calls the callback immediately with the current user, then again on every change.

## Broadcasting Auth Changes

If you build custom auth UI instead of using the `Authenticator`, the app still needs to know when auth changed so other components and tabs react. Use `submitAuthAction` as the single notifier: it submits the action, advances the cached state, and broadcasts on any signed-in / signed-out transition, so both sign-in **and** sign-out keep the UI reactive.

```typescript
import { submitAuthAction } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

// Sign-in: submits, updates the cache, and broadcasts the transition.
const next = await submitAuthAction(authApi, { action: 'signIn', username: 'alice', password: 'secret' });
if (next.retriable) showError(next.error); // wrong password / MFA code: re-prompt, nothing broadcast

// Sign-out is the SAME call. The broadcast fires on the transition, so
// AccountMenuBar, AuthenticatedContent, and other tabs update immediately.
await submitAuthAction(authApi, { action: 'signOut' });
```

`submitAuthAction(api, input)` returns the resulting `AuthState`. A bare `setAuthState` call flips the server session but notifies **nothing** on the client, which is why custom UI that calls it directly goes stale (notably on sign-out; issue #185). The `Authenticator` uses `submitAuthAction` internally, so you get this for free when you use it.

### `broadcastAuthChange` (lower-level primitive)

`broadcastAuthChange` is the underlying broadcast primitive that `submitAuthAction` calls. Reach for it directly only when auth state changed through a path `submitAuthAction` doesn't cover and you need to fan the change out yourself:

```typescript
import { broadcastAuthChange } from '@aws-blocks/auth-common/ui';

// After a successful sign-in
broadcastAuthChange({ userId: 'alice', username: 'alice' });

// After sign-out
broadcastAuthChange(null);
```

For a full walkthrough of custom UI, including the `setAuthState` loop and the `AuthActionInput` contract, see [Customizing Auth UI](./CUSTOMIZING-AUTH-UI.md).

## Types Reference

### `AuthState`

Returned by `getAuthState()` and `setAuthState()`.

| Field | Type | Description |
|---|---|---|
| `state` | `string` | `'signedOut'`, `'signedIn'`, `'confirmingSignUp'`, `'confirmingMfa'`, `'confirmingPasswordReset'` |
| `user` | `AuthUser?` | Present when `state === 'signedIn'` |
| `actions` | `AuthAction[]` | Available actions from this state |
| `error` | `string?` | Error from the last action |

### `AuthAction`

All actions are forms. They differ in where they submit.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Action name. Used as the `action` discriminant in `setAuthState({ action, ...fields })`. |
| `label` | `string` | Button label (e.g., "Sign In", "Sign in with Google") |
| `fields` | `AuthField[]` | Form fields |
| `url` | `string?` | External form target. When present, submit an HTML form here instead of calling `setAuthState()`. |
| `method` | `'GET' \| 'POST'?` | HTTP method for external forms. Default: `'GET'`. |

### `AuthField`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Field name (key in the fields record) |
| `label` | `string` | Human-readable label |
| `type` | `string` | `'text'`, `'password'`, `'email'`, `'tel'`, `'number'`, `'hidden'` |
| `required` | `boolean` | Whether the field is required |
| `defaultValue` | `string?` | Default value if the client doesn't provide one |

### `AuthUser`

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | Unique identifier |
| `username` | `string` | Display name or username |

Provider-specific BBs extend this (e.g., `AuthBasicUser` adds `createdAt`).
