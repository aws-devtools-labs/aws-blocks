# @aws-blocks/auth-common

Shared interfaces and UI components for AWS Blocks authentication: the `BlocksAuth` contract that `Auth` implements, the `AuthErrors` vocabulary, and the provider-agnostic sign-in UI. Use this package to build provider-agnostic auth UI, or import the types when authoring a custom auth Building Block.

> For authentication itself, use `Auth` (`@aws-blocks/bb-auth`, also exported from `@aws-blocks/blocks`): one block for email + password, social sign-in, OIDC and SAML. Its README explains which sign-in option to choose and why.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Exports

| Export Path | What it provides |
|---|---|
| `@aws-blocks/auth-common` | Types: `BlocksAuth`, `AuthUser`, `AuthState`, `AuthAction`, `AuthField`, `AuthErrorName`. Values: `AuthErrors`, `isAuthError`, `isAuthErrorName` |
| `@aws-blocks/auth-common/ui` | Components: `AccountMenuBar`, `Authenticator`, `AuthenticatedContent`. Custom UI: `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`, `onAuthChange`, `broadcastAuthChange` |
| `@aws-blocks/auth-common/cookies` | Shared session-cookie security policy: `resolveCookieSecurity`, `buildCookieSecurityAttrs`, `isLoopbackRequest` |

## Session-cookie security policy (`/cookies`)

`Auth` routes its session-cookie `SameSite` / `Secure` / `Partitioned` selection through this one helper, and a custom auth BB should too, so they converge structurally instead of drifting. Given `{ crossDomain, isLocalhost }` it returns the canonical attributes:

| `crossDomain` | `isLocalhost` | attributes |
|---|---|---|
| `false` (default) | `false` | `SameSite=Lax; Secure` |
| `false` | `true` | `SameSite=Lax` |
| `true` | `false` | `SameSite=None; Secure; Partitioned` |
| `true` | `true` | `SameSite=None; Secure` |

`buildCookieSecurityAttrs(input)` returns the string form for BBs that assemble `Set-Cookie` by hand; `resolveCookieSecurity(input)` returns the attribute object for BBs that pass a structured cookie config. `isLoopbackRequest(ctx)` detects loopback origins (`localhost`, `127.0.0.1`, `[::1]`) for per-request `isLocalhost` decisions.


## Server-Side Interface (`BlocksAuth`)

`Auth` implements `BlocksAuth`, and so can a custom auth Building Block. Server-side code is identical regardless of provider:

```typescript
import { Auth } from '@aws-blocks/bb-auth';

const auth = new Auth(scope, 'auth');

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
| `requireRole(context, role)` | `Promise<AuthUser>` | Role-gated endpoints. Throws 401 if not signed in, 403 if not in `role`. Required in the interface; `Auth` implements it. |

`requireAuth` throws `NotAuthenticatedException` (`AuthErrors.NotAuthenticated`).

## Auth error names (`AuthErrors`)

`AuthErrors` is the shared vocabulary of auth error names. Each value is the `name` of the `ApiError` an auth BB throws, and the `errorName` it sets on a failed `AuthState`. Errors cross the wire by `name`, so the same check works on the server and in the browser:

```typescript
import { ApiNamespace, Scope } from '@aws-blocks/core';
import { AuthErrors, isAuthError } from '@aws-blocks/auth-common';
import { Auth } from '@aws-blocks/bb-auth';

const scope = new Scope('app');
const auth = new Auth(scope, 'auth');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getGreeting() {
    try {
      const user = await auth.requireAuth(context);
      return `Hello ${user.username}`;
    } catch (e: unknown) {
      // Same check client-side, on the error the API call rejects with.
      if (isAuthError(e, AuthErrors.NotAuthenticated)) return 'Hello guest';
      throw e;
    }
  },
}));
```

- `isAuthError(e, AuthErrors.X)` narrows `e` to `Error & { name: 'X…' }`. It is `isBlocksError` from `@aws-blocks/core`, restricted to auth names, so a typo or an unknown name fails to compile.
- `isAuthError(e)` (no name) matches any name in `AuthErrors`. Some names, such as `InvalidParameterException` or `ResourceNotFoundException`, are not unique to auth — prefer passing the specific name you handle.
- `isAuthErrorName(value)` narrows a string (e.g. `state.errorName` from `setAuthState`) to `AuthErrorName`. To branch on one specific name on that path, use `hasAuthError(state, AuthErrors.X)` from `@aws-blocks/core`.

The names follow Amazon Cognito's exception names wherever Cognito has one (for example `UsernameExistsException`, `CodeMismatchException`). `Auth` reports every failure with one of these names (an error it does not recognise becomes `InternalErrorException`); only an `ApiError` your own `validateUser` / `onSignIn` hook throws keeps the name you gave it. See [DESIGN.md](./DESIGN.md#auth-error-vocabulary) for how the names the removed `AuthBasic`, `AuthCognito` and `AuthOIDC` blocks used map onto `AuthErrors`.

## Authenticator Component

The `Authenticator` renders auth UI driven by the state machine. It works with `Auth`, whatever sign-in methods it is configured with, and with any custom auth BB that serves the same state machine, because it renders based on `AuthState`, not provider-specific logic.

```typescript
import { Authenticator } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi));
```

To restyle, relabel, hide, or fully replace the rendered forms, see
[Customizing Auth UI](../bb-auth/CUSTOMIZING-AUTH-UI.md).

The component:
- Calls `getAuthState()` on mount to determine what to render
- Renders form fields and submit buttons for each available action
- For internal actions (no `url`): collects input and submits it with [`submitAuthAction`](#custom-auth-ui-submitauthaction)
- For external actions (with `url`): renders an HTML form that submits to the external URL (OAuth/OIDC)
- Broadcasts sign-in and sign-out to other components and tabs, and re-renders when they arrive. Mid-flow steps (for example the confirm-code form) advance the `Authenticator` without a broadcast

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

### Fallback for unauthenticated users

Pass an optional third argument to display alternative content when the user is NOT signed in:

```typescript
const loginPrompt = document.createElement('p');
loginPrompt.textContent = 'Please sign in to continue.';

document.body.appendChild(
  AuthenticatedContent(authApi, (user) => {
    const el = document.createElement('div');
    el.textContent = `Welcome, ${user.username}`;
    return el;
  }, loginPrompt)
);
```

When no fallback is provided the container renders nothing while signed out (backward-compatible).

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

## Custom auth UI: `submitAuthAction`

If you build your own sign-in form instead of using the `Authenticator`, submit every action with `submitAuthAction`. A bare `authApi.setAuthState(...)` changes the session on the server but **notifies nothing** on the client, so `onAuthChange`, `AuthenticatedContent`, `AccountMenuBar` and other tabs keep showing the old state until a reload.

```typescript
import { submitAuthAction } from '@aws-blocks/blocks/ui';
import { authApi } from 'aws-blocks';

export async function signIn(username: string, password: string): Promise<string | undefined> {
  const next = await submitAuthAction(authApi, { action: 'signIn', username, password });
  if (next.retriable) return next.error; // wrong password, bad code, …: stay on the form
  // Signed in (or on to a challenge step such as confirmingSignIn). Every
  // onAuthChange subscriber, AuthenticatedContent and other tab already knows.
  return undefined;
}

export async function signOut(): Promise<void> {
  await submitAuthAction(authApi, { action: 'signOut' }); // the same call for sign-out
}
```

```typescript
function submitAuthAction(api: AuthStateApi, input: AuthActionInput): Promise<AuthState>
```

It calls `setAuthState(input)` once and resolves to exactly what that returned, then:

- `retriable: true` — changes nothing. Keep the current form (and its hidden fields, such as `session`) and show `error` inline.
- any other result — updates the shared auth-state store (below), so every mounted `Authenticator` re-renders, mid-flow steps included.
- a `signedIn` or `signedOut` result — also broadcasts `user ?? null` to `onAuthChange` subscribers in this window and in other tabs. Mid-flow steps are not broadcast.
- a rejected call (network, 5xx) — rejects with the same error and changes nothing.

`input` is the same discriminated `AuthActionInput` as `setAuthState`, so a wrong payload is a compile error. Outside a browser (SSR, Node scripts) it is just the RPC: nothing is cached or broadcast, and nothing throws. Pass the same `authApi` object every time; the store is keyed by its identity.

The `Authenticator` and `AccountMenuBar` submit through it too, so each sign-in or sign-out notifies exactly once. For the full custom-UI walkthrough see [Customizing Auth UI](../bb-auth/CUSTOMIZING-AUTH-UI.md).

## Auth State Store (React)

`subscribeAuthState` and `getAuthStateSnapshot` expose the same per-`api` state the `Authenticator` renders from, shaped for React's `useSyncExternalStore`:

```tsx
import { useSyncExternalStore } from 'react';
import { getAuthStateSnapshot, subscribeAuthState } from '@aws-blocks/blocks/ui';
import { authApi } from 'aws-blocks';

const subscribe = (cb: () => void) => subscribeAuthState(authApi, cb);
const getSnapshot = () => getAuthStateSnapshot(authApi);

export function useAuthState() {
  return useSyncExternalStore(subscribe, getSnapshot, () => null); // null = not yet known
}
```

```typescript
function subscribeAuthState(api: AuthStateApi, listener: (state: AuthState) => void): () => void
function getAuthStateSnapshot(api: AuthStateApi): AuthState | null
```

- `getAuthStateSnapshot` reads without a network call. It returns `null` until the first `getAuthState()` lands (`null` means "not yet known", not "signed out"), and always on the server. The object keeps its identity until the state changes.
- `subscribeAuthState` starts that first `getAuthState()` if needed (one shared request, however many subscribers), and then calls `listener` on every change: every non-retriable `submitAuthAction` result, mid-flow steps included, and a sign-in or sign-out in another tab (one refetch per `authApi`). It never calls `listener` synchronously, and it returns an unsubscribe function you can call more than once.

Use the store when you render the auth *flow* (challenge steps, errors). Use `onAuthChange` when you only care about *who* is signed in.

## Broadcasting Auth Changes

`broadcastAuthChange` is the lower-level primitive `submitAuthAction` uses. You rarely need it directly: call it only when the session changed by some route other than `submitAuthAction`, such as a sign-in your own server endpoint completed.

```typescript
import { broadcastAuthChange } from '@aws-blocks/blocks/ui';

// After a successful sign-in
broadcastAuthChange({ userId: 'alice', username: 'alice' });

// After sign-out
broadcastAuthChange(null);
```

```typescript
function broadcastAuthChange(user: AuthUser | null): void
```

Pass the signed-in `AuthUser`, or `null` for a sign-out. It fires a `BroadcastChannel` message for other tabs plus a window event for the current tab, which is what every `onAuthChange` subscriber listens to. It does not update the auth-state store, so `subscribeAuthState` listeners don't see it. It is browser-only: it touches `window`, so don't call it during SSR.

Application code normally installs the umbrella package rather than `auth-common`, and there the import is **`@aws-blocks/blocks/ui`**:

```typescript
import { Authenticator, onAuthChange, submitAuthAction } from '@aws-blocks/blocks/ui';
```

The root `@aws-blocks/blocks` entry point does not export them, because the UI exports live behind the `/ui` subpath so backend bundles don't pull in DOM code. `@aws-blocks/auth-common/ui` and `@aws-blocks/blocks/ui` are the same functions; use the umbrella path unless you depend on `auth-common` directly.

## Types Reference

### `AuthState`

Returned by `getAuthState()` and `setAuthState()`.

| Field | Type | Description |
|---|---|---|
| `state` | `'signedOut' \| 'signedIn' \| 'confirmingSignUp' \| 'confirmingSignIn' \| 'confirmingMfa' \| 'confirmingPasswordReset'` | Current state name |
| `user` | `AuthUser?` | Present when `state === 'signedIn'` |
| `actions` | `AuthAction[]` | Available actions from this state |
| `error` | `string?` | Error from the last action |
| `errorName` | `string?` | Machine-readable name of the last action's error, mirroring the thrown `ApiError`'s `name` (e.g. `'InvalidCredentialsException'`). Branch on it with `hasAuthError(state, name)` instead of matching the human-facing `error`. Absent on success or a generic `ApiError`. |
| `retriable` | `boolean?` | The last action failed recoverably: resubmit on the **same** state (preserving hidden fields such as `session`) and show `error` inline, instead of restarting the flow. |

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

Auth BBs extend this (e.g., `Auth`'s `AuthenticatedUser` adds `userSub`, `groups`, `attributes` and `signInProvider`).
