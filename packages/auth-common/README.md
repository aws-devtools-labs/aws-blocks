# @aws-blocks/auth-common

Shared interfaces and UI components for all AWS Blocks auth Building Blocks. Use this package to build provider-agnostic auth UI, or import the types when authoring a custom auth Building Block.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Exports

| Export Path | What it provides |
|---|---|
| `@aws-blocks/auth-common` | Types: `BlocksAuth`, `AuthUser`, `AuthState`, `AuthAction`, `AuthField` |
| `@aws-blocks/auth-common/ui` | Components: `AccountMenuBar`, `Authenticator`, `AuthenticatedContent`, `onAuthChange`, `broadcastAuthChange`; theme: `injectTheme`, `THEME_CSS`, `THEME_STYLE_ID` |
| `@aws-blocks/auth-common/theme` | Design-token layer: `injectTheme`, `THEME_CSS`, `THEME_STYLE_ID` |
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

## Broadcasting Auth Changes

If you build custom auth UI instead of using the `Authenticator`, broadcast changes so other components and tabs react:

```typescript
import { broadcastAuthChange } from '@aws-blocks/auth-common/ui';

// After a successful sign-in
broadcastAuthChange({ userId: 'alice', username: 'alice' });

// After sign-out
broadcastAuthChange(null);
```

```typescript
function broadcastAuthChange(user: AuthUser | null): void
```

Pass the signed-in `AuthUser`, or `null` for a sign-out. It fires a `BroadcastChannel` message for other tabs plus a window event for the current tab, which is what every `onAuthChange` subscriber listens to. It is browser-only: it touches `window`, so don't call it during SSR.

Application code normally installs the umbrella package rather than `auth-common`, and there the import is **`@aws-blocks/blocks/ui`**:

```typescript
import { broadcastAuthChange, onAuthChange, Authenticator } from '@aws-blocks/blocks/ui';
```

The root `@aws-blocks/blocks` entry point does not export it, because the UI exports live behind the `/ui` subpath so backend bundles don't pull in React. `@aws-blocks/auth-common/ui` and `@aws-blocks/blocks/ui` are the same function; use the umbrella path unless you depend on `auth-common` directly.

The `Authenticator` component does this automatically. You only need `broadcastAuthChange` if you're building custom UI. For a full walkthrough of custom UI, including the `setAuthState` loop and the `AuthActionInput` contract, see [Customizing Auth UI](./CUSTOMIZING-AUTH-UI.md).

## Theming (`injectTheme` + `--bb-*` tokens)

The UI components ship a framework-neutral design-token layer. Each
component (`Authenticator`, `AccountMenuBar`, `AuthenticatedContent`)
injects a small stylesheet into `document.head` the first time it
renders, so the themed look travels with the component into any host —
lit-html, vanilla DOM, React, Next.js — with no stylesheet to import.

The stylesheet is CSS custom properties on `:root` (`--bb-color-*`,
`--bb-space-*`, `--bb-radius-*`, `--bb-font-*`, `--bb-shadow-*`) plus the
base `.bb-*` component classes the components render against. A light and
a dark palette are provided; dark is selected automatically by
`prefers-color-scheme`.

Because the tokens are on `:root`, your own markup can consume them for a
consistent look without importing anything:

```css
.my-button {
  background: var(--bb-color-accent);
  color: var(--bb-color-accent-text);
  border-radius: var(--bb-radius-sm);
  padding: var(--bb-space-2) var(--bb-space-4);
}
```

Force a specific palette by setting `data-bb-theme` on any ancestor
(it wins over the media query):

```html
<body data-bb-theme="dark"> ... </body>
```

Call `injectTheme()` yourself to make the tokens available before any
component mounts (for example, to theme your page chrome at startup). It
is idempotent and SSR-safe — a second call is a no-op, and it returns
silently when there is no `document`:

```typescript
import { injectTheme } from '@aws-blocks/blocks/ui';

injectTheme();
```

`THEME_CSS` (the stylesheet as a string) and `THEME_STYLE_ID` (the
`<style>` element's id) are also exported for hosts that bundle the CSS
through a build step or assert against it in tests.

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

Provider-specific BBs extend this (e.g., `AuthBasicUser` adds `createdAt`).
