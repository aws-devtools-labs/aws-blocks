# @aws-cdk-blocks/auth-common

Shared interfaces and UI components for AWS CDK Blocks authentication: the `BlocksAuth` contract that `Auth` implements, the `AuthErrors` vocabulary, and the provider-agnostic sign-in UI. Use this package to build provider-agnostic auth UI, or import the types when authoring a custom auth Building Block.

> For authentication itself, use `Auth` (`@aws-cdk-blocks/bb-auth`, also exported from `aws-cdk-blocks`): one block for email + password, social sign-in, OIDC and SAML. Its README explains which sign-in option to choose and why.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Exports

| Export Path | What it provides |
|---|---|
| `@aws-cdk-blocks/auth-common` | Types: `BlocksAuth`, `AuthUser`, `AuthState`, `AuthAction`, `AuthField`, `AuthErrorName`. Values: `AuthErrors`, `isAuthError`, `isAuthErrorName` |
| `@aws-cdk-blocks/auth-common/ui` | Components: `AccountMenuBar`, `Authenticator`, `AuthenticatedContent`, `MfaSettings`, `StatusMessage`. Custom UI: `submitAuthAction`, `subscribeAuthState`, `getAuthStateSnapshot`, `onAuthChange`, `broadcastAuthChange`; theme: `injectTheme`, `THEME_CSS`, `THEME_STYLE_ID` |
| `@aws-cdk-blocks/auth-common/theme` | Design-token layer: `injectTheme`, `THEME_CSS`, `THEME_STYLE_ID` |
| `@aws-cdk-blocks/auth-common/cookies` | Shared session-cookie security policy: `resolveCookieSecurity`, `buildCookieSecurityAttrs`, `isLocalDevRequest`, `isLoopbackRequest`, `isInsecurePublicOrigin` |

Application code installs `aws-cdk-blocks`, and there the UI import is `aws-cdk-blocks/ui`. It exports the same functions as `@aws-cdk-blocks/auth-common/ui`, and the examples below use either path. Use `aws-cdk-blocks/ui` unless you depend on `auth-common` directly. The root `aws-cdk-blocks` entry does not export the UI.

## Server-side interface (`BlocksAuth`)

`Auth` implements `BlocksAuth`, and so can a custom auth Building Block. Server-side code is identical regardless of provider:

```typescript
import { Auth } from '@aws-cdk-blocks/bb-auth';

const auth = new Auth(scope, 'auth');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Throws 401 if the caller is not signed in.
  async getProfile() {
    const user = await auth.requireAuth(context);
    return { username: user.username };
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

`AuthErrors` lists the names an auth block uses for a thrown `ApiError` or the `errorName` on a failed `AuthState`. In browser application code, use `isBlocksError` from `aws-cdk-blocks/client` to match a caught error by name:

```typescript
import { isBlocksError } from 'aws-cdk-blocks/client';
import { api } from 'cdk-blocks';

try {
  await api.getProfile();
} catch (e: unknown) {
  if (isBlocksError(e, 'NotAuthenticatedException')) showSignIn(); // your own function
  else throw e;
}
```

On the server, import `AuthErrors` and `isAuthError` from `aws-cdk-blocks` (or directly from `@aws-cdk-blocks/auth-common`). `isAuthError(e, AuthErrors.NotAuthenticated)` makes the same check as the browser example: `e` must be an `Error` with that exact name. Its name argument is restricted to `AuthErrorName`. Without a name, `isAuthError(e)` matches an `Error` with any name in `AuthErrors`; it does not prove the error came from auth.

If `setAuthState()` returns a failed state instead of throwing, use `hasAuthError(state, 'NotAuthorizedException')` from `aws-cdk-blocks/client` to match `state.errorName`. Use `isAuthErrorName(value)` from `@aws-cdk-blocks/auth-common` to narrow an unknown value to `AuthErrorName`.

The names follow Amazon Cognito's exception names wherever Cognito has one (for example `UsernameExistsException`, `CodeMismatchException`). `Auth` reports every failure with one of these names (an error it does not recognise becomes `InternalErrorException`); only an `ApiError` your own `validateUser` / `onSignIn` hook throws keeps the name you gave it.

For HTTP statuses and their exceptions, see [Errors in `Auth`](../bb-auth/README.md#errors).

| Constant | `error.name` | Meaning |
|---|---|---|
| `NotAuthenticated` | `NotAuthenticatedException` | No valid session. Send the user to sign-in. |
| `NotAuthorized` | `NotAuthorizedException` | Credentials rejected, or the signed-in user lacks the required role. Sign-in reports an unknown user, a wrong password and a disabled user identically under this name. |
| `PasswordResetRequired` | `PasswordResetRequiredException` | The user must reset their password before they can sign in. |
| `TokenExpired` | `TokenExpiredException` | The session's refresh token was rejected or has expired. |
| `ReauthenticationRequired` | `ReauthenticationRequiredException` | The session is valid but too old for an operation that requires a recent sign-in. |
| `SignOutIncomplete` | `SignOutIncompleteException` | Sign-out cleared the session cookie but could not delete the server-side session. |
| `UserAlreadyExists` | `UsernameExistsException` | A user with this username already exists. |
| `UserNotConfirmed` | `UserNotConfirmedException` | The user signed up but has not confirmed their account. |
| `UserNotFound` | `UserNotFoundException` | No such user. Privileged (admin) operations only, never a public sign-in path. |
| `AliasExists` | `AliasExistsException` | The email or phone alias is already in use by another user of the pool. |
| `UnsupportedUserState` | `UnsupportedUserStateException` | The user is in a state that does not allow the operation. |
| `InvalidPassword` | `InvalidPasswordException` | The password does not meet the password policy. |
| `CodeMismatch` | `CodeMismatchException` | The verification or MFA code is wrong. Retry with the correct code. |
| `ExpiredCode` | `ExpiredCodeException` | The verification code has expired. Request a new one. |
| `InvalidParameter` | `InvalidParameterException` | A request parameter is missing or malformed. |
| `MFAMethodNotFound` | `MFAMethodNotFoundException` | The requested MFA method is not set up for this user. |
| `SoftwareTokenMFANotFound` | `SoftwareTokenMFANotFoundException` | Authenticator-app (TOTP) MFA is not set up for this user. |
| `EnableSoftwareTokenMFA` | `EnableSoftwareTokenMFAException` | The TOTP code submitted while setting up an authenticator app does not match. Retriable on the same session. |
| `WebAuthnNotEnabled` | `WebAuthnNotEnabledException` | Passkeys are not enabled for this user pool. |
| `WebAuthnOriginNotAllowed` | `WebAuthnOriginNotAllowedException` | The passkey assertion came from an origin that is not allow-listed. |
| `WebAuthnRelyingPartyMismatch` | `WebAuthnRelyingPartyMismatchException` | The credential's relying-party id does not match the pool's configuration. |
| `WebAuthnChallengeNotFound` | `WebAuthnChallengeNotFoundException` | The WebAuthn challenge expired or the session was lost. Restart the flow. |
| `WebAuthnCredentialNotSupported` | `WebAuthnCredentialNotSupportedException` | The pool's configuration does not support the credential type or algorithm. |
| `WebAuthnClientMismatch` | `WebAuthnClientMismatchException` | The passkey assertion was issued for a different app client. |
| `WebAuthnConfigurationMissing` | `WebAuthnConfigurationMissingException` | The pool lacks the WebAuthn configuration (relying-party id, origins) passkeys need. |
| `ProviderNotConfigured` | `ProviderNotConfiguredException` | The requested sign-in provider is not configured on this auth block. |
| `ProviderUnavailable` | `ProviderUnavailableException` | The provider's configuration is unusable at runtime, the provider cannot be reached, or it is not available in this runtime (a Cognito-federated provider under `npm run dev`). |
| `IdpError` | `IdpErrorException` | The identity provider returned an error, or the token exchange with it failed. |
| `InvalidState` | `InvalidStateException` | The sign-in `state` parameter is missing, invalid or does not match. |
| `InvalidCallback` | `InvalidCallbackException` | The provider callback is missing required parameters. |
| `InvalidRelay` | `InvalidRelayException` | A post-sign-in relay target was rejected. |
| `SdkOutdated` | `SdkOutdatedException` | The client SDK is too old for this server's sign-in flow. |
| `EmailPasswordNotEnabled` | `EmailPasswordNotEnabledException` | An email + password method was called on an auth block that has email + password sign-in turned off. |
| `NoFederatedProvider` | `NoFederatedProviderException` | A federated sign-in method was called on an auth block with no federated provider. |
| `PasskeysNotEnabled` | `PasskeysNotEnabledException` | A passkey method or sign-in action was called on an auth block that has passkeys turned off. |
| `MfaNotEnabled` | `MfaNotEnabledException` | An MFA method, or a challenge answer only MFA produces, was sent to an auth block that has MFA turned off. |
| `LimitExceeded` | `LimitExceededException` | A service limit was exceeded, for example too many codes requested. Retry later. |
| `TooManyRequests` | `TooManyRequestsException` | The request rate is too high. Retry with backoff. |
| `TooManyFailedAttempts` | `TooManyFailedAttemptsException` | Too many failed attempts: the operation is temporarily locked. |
| `GroupNotFound` | `ResourceNotFoundException` | The named group does not exist. |
| `InvalidLambdaResponse` | `InvalidLambdaResponseException` | An auth Lambda trigger returned a malformed response. |
| `UserLambdaValidation` | `UserLambdaValidationException` | An auth Lambda trigger rejected the request. |
| `InternalError` | `InternalErrorException` | A service-side failure. Safe to retry with backoff. |
| `InsecureTransport` | `InsecureTransportException` | The auth block refused to issue a session cookie over a plain-HTTP front door outside a sandbox deploy. |

## Authenticator component

`Authenticator(authApi, options?)` renders the forms for the current `AuthState`. It works with `Auth`, whatever sign-in methods it is configured with, and with any custom auth BB that serves the same state machine.

```typescript
import { Authenticator } from '@aws-cdk-blocks/auth-common/ui';
import { authApi } from 'cdk-blocks';

document.body.appendChild(Authenticator(authApi));
```

To restyle, relabel, hide, or fully replace the rendered forms, see
[Customizing Auth UI](../bb-auth/CUSTOMIZING-AUTH-UI.md).

The `Authenticator` broadcasts sign-in and sign-out to other components and tabs, and re-renders when they arrive. Mid-flow steps (for example the confirm-code form) advance the `Authenticator` without a broadcast.

## AccountMenuBar

Compact bar for the top of the page. Shows "👤 username | Sign Out" when signed in, or a "Sign In" button when signed out. Clicking "Sign In" opens the `Authenticator` in a modal overlay.

```typescript
import { AccountMenuBar } from '@aws-cdk-blocks/auth-common/ui';
import { authApi } from 'cdk-blocks';

document.body.prepend(AccountMenuBar(authApi));
```

Use `AccountMenuBar` for the page header and `Authenticator` when you want a standalone sign-in form (for example, a dedicated login page).

## AuthenticatedContent

`AuthenticatedContent(authApi, render, fallback?)` renders `render(user)` only while a user is signed in, and updates when the auth state changes (same window and cross-tab). The optional third argument is shown while signed out; without it the container renders nothing.

```typescript
import { AuthenticatedContent } from '@aws-cdk-blocks/auth-common/ui';
import { authApi } from 'cdk-blocks';

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

## MfaSettings

`MfaSettings(authApi, options?)` is the authenticator-app (TOTP) enrolment and MFA-preference panel for an account page. It needs an auth block with MFA on (`Auth` with `mfa`) and renders nothing while signed out:

```typescript
import { MfaSettings } from '@aws-cdk-blocks/auth-common/ui';
import { authApi } from 'cdk-blocks';

document.querySelector('#security')!.appendChild(MfaSettings(authApi));
```

Pass `renderQrCode: (otpauthUri) => Node` to draw the setup QR code with a library of your choice. The other options and the test hooks: [Customizing Auth UI](../bb-auth/CUSTOMIZING-AUTH-UI.md#mfa-settings).

## StatusMessage

`StatusMessage(options?)` is a themed status line for the loading, success and error states of an async operation. `options` is `{ kind?, text?, testId? }`. It returns a handle: mount `handle.element`, then call `handle.set(kind, text)` as the operation progresses.

```typescript
import { StatusMessage } from '@aws-cdk-blocks/auth-common/ui';

const status = StatusMessage({ kind: 'loading', text: 'Loading…' });
document.querySelector('#app-status')!.replaceWith(status.element);

try {
  await saveSettings(); // your own async work
  status.set('success', 'Done.');
} catch (e) {
  status.set('error', `Failed: ${(e as Error).message}`);
}
```

The element is a polite ARIA live region (`role="status"`, `aria-live="polite"`). The `loading` state renders a spinner that honors `prefers-reduced-motion`. All colors come from the shared `--bb-*` tokens.

| `kind` | Appearance |
|---|---|
| `idle` | muted text (`--bb-color-text-muted`) |
| `loading` | muted text + animated spinner |
| `success` | green (`--bb-color-success`) |
| `error` | red (`--bb-color-danger`) |

Pass `testId` to scope the root (and its `-text` child) when a page renders more than one status region.

## Auth state change subscription

Subscribe to auth state changes from any source (same window + other tabs):

```typescript
import { onAuthChange } from '@aws-cdk-blocks/auth-common/ui';
import { authApi } from 'cdk-blocks';

const unsubscribe = onAuthChange(authApi, (user) => {
  if (user) {
    console.log('Signed in:', user.username);
  } else {
    console.log('Signed out');
  }
});

// Later: unsubscribe();
```

`onAuthChange(authApi, callback)` calls `callback` immediately with the current user (or `null`), then on every sign-in and sign-out, in this window and in other tabs. It returns an unsubscribe function.

The user is typed by the API you pass: with `Auth`'s `authApi` it is that block's `AuthStateUser` (`groups`, `attributes`, `userSub`), so `user?.groups` needs no cast; with a plain `AuthStateApi` it is an `AuthUser`. `AuthUserOf<typeof authApi>` names it.

## Types reference

### `AuthState`

Returned by `getAuthState()` and `setAuthState()`.

| Field | Type | Description |
|---|---|---|
| `state` | `'signedOut' \| 'signedIn' \| 'confirmingSignUp' \| 'confirmingSignIn' \| 'confirmingMfa' \| 'confirmingPasswordReset'` | Current state name |
| `user` | `AuthUser?` | Present when `state === 'signedIn'` |
| `actions` | `AuthAction[]` | Available actions from this state |
| `error` | `string?` | Error from the last action |
| `errorName` | `string?` | Machine-readable name of the last action's error, mirroring the thrown `ApiError`'s `name` (for example, `'NotAuthorizedException'`). Branch on it with `hasAuthError(state, name)` instead of matching the human-facing `error`. Absent on success or a generic `ApiError`. |
| `retriable` | `boolean?` | The last action failed recoverably: resubmit on the **same** state (preserving hidden fields such as `session`) and show `error` inline, instead of restarting the flow. |

### `AuthAction`

All actions are forms. They differ in where they submit.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Action name. Used as the `action` discriminant in `setAuthState({ action, ...fields })`. |
| `label` | `string` | Button label (for example, "Sign In", "Sign in with Google") |
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

Auth BBs extend this (for example, `Auth`'s `AuthenticatedUser` adds `userSub`, `groups`, `attributes` and `signInProvider`).

## Custom auth UI: `submitAuthAction`

If you build your own sign-in form instead of using the `Authenticator`, submit every action with `submitAuthAction`. A bare `authApi.setAuthState(...)` changes the session on the server but **notifies nothing** on the client, so `onAuthChange`, `AuthenticatedContent`, `AccountMenuBar` and other tabs keep showing the old state until a reload.

```typescript
import { submitAuthAction } from 'aws-cdk-blocks/ui';
import { authApi } from 'cdk-blocks';

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
function submitAuthAction<A extends AuthStateApi<never>>(api: A, input: Parameters<A['setAuthState']>[0]): Promise<AuthState<AuthUserOf<A>>>
```

It calls `setAuthState(input)` once and resolves to exactly what that returned, then:

- `retriable: true` changes nothing. Keep the current form (and its hidden fields, such as `session`) and show `error` inline.
- any other result updates the shared auth-state store (below), so every mounted `Authenticator` re-renders, mid-flow steps included.
- a `signedIn` or `signedOut` result also broadcasts `user ?? null` to the `onAuthChange` subscribers of this `authApi`, in this window and in other tabs. Mid-flow steps are not broadcast. With two auth blocks on a page, another block's `onAuthChange` (and store) ignores it.
- a rejected call (network, 5xx) rejects with the same error and changes nothing.

`input` is the same discriminated `AuthActionInput` as `setAuthState`. Both calls are fully typed, so a custom form needs no `as any`. A literal `action` narrows the input (wrong fields are a compile error), and the result is an `AuthState`. With `Auth`, `input` is also checked against the actions that block's options allow ([Mode gates](../bb-auth/README.md#mode-gates)).

Outside a browser (SSR, Node scripts) the call is only the RPC: nothing is cached or broadcast, and nothing throws. Pass the same `authApi` object every time; the store is keyed by its identity.

The `Authenticator` and `AccountMenuBar` submit through it too, so each sign-in or sign-out notifies exactly once. For the full custom-UI walkthrough see [Customizing Auth UI](../bb-auth/CUSTOMIZING-AUTH-UI.md).

## Auth state store (React)

`subscribeAuthState` and `getAuthStateSnapshot` expose the same per-`api` state the `Authenticator` renders from, shaped for React's `useSyncExternalStore`:

```tsx
import { useSyncExternalStore } from 'react';
import { getAuthStateSnapshot, subscribeAuthState } from 'aws-cdk-blocks/ui';
import { authApi } from 'cdk-blocks';

const subscribe = (cb: () => void) => subscribeAuthState(authApi, cb);
const getSnapshot = () => getAuthStateSnapshot(authApi);

export function useAuthState() {
  return useSyncExternalStore(subscribe, getSnapshot, () => null); // null = not yet known
}
```

```typescript
function subscribeAuthState<A extends AuthStateApi<never>>(api: A, listener: (state: AuthState<AuthUserOf<A>>) => void): () => void
function getAuthStateSnapshot<A extends AuthStateApi<never>>(api: A): AuthState<AuthUserOf<A>> | null
```

- `getAuthStateSnapshot` reads without a network call. It returns `null` until the first `getAuthState()` lands (`null` means "not yet known", not "signed out"), and always on the server. The object keeps its identity until the state changes.
- `subscribeAuthState` starts that first `getAuthState()` if needed (one shared request, however many subscribers), then calls `listener` on every state change: a non-retriable `submitAuthAction` result, mid-flow steps included, and a sign-in or sign-out in another tab. It never calls `listener` synchronously, and it returns an unsubscribe function you can call more than once.

Use the store when you render the auth *flow* (challenge steps, errors). Use `onAuthChange` when you only care about *who* is signed in.

## Broadcasting auth changes

`broadcastAuthChange` is the lower-level primitive `submitAuthAction` uses. You rarely need it directly: call it only when the session changed by some route other than `submitAuthAction`, such as a sign-in your own server endpoint completed.

```typescript
import { broadcastAuthChange } from 'aws-cdk-blocks/ui';
import { authApi } from 'cdk-blocks';

// After a successful sign-in
broadcastAuthChange({ userId: 'alice', username: 'alice' });

// After sign-out
broadcastAuthChange(null);

// With two auth blocks on the page: only this block's listeners
broadcastAuthChange(null, authApi);
```

```typescript
function broadcastAuthChange(user: AuthUser | null, api?: AuthStateApi<never>): void
```

Pass the signed-in `AuthUser`, or `null` for a sign-out. Pass `api` so that only that API's `onAuthChange` subscribers get the message; without it, every API's do. It does not update the auth-state store, so `subscribeAuthState` listeners don't see it. It is browser-only: don't call it during SSR.

## Theming (`injectTheme` + `--bb-*` tokens)

The UI components ship a framework-neutral design-token layer. Each component injects one stylesheet into `document.head` the first time it renders, so there is no stylesheet to import.

The stylesheet is CSS custom properties on `:root` (`--bb-color-*`, `--bb-space-*`, `--bb-radius-*`, `--bb-font-*`, `--bb-shadow-*`) plus the base `.bb-*` component classes the components render against. A light and a dark palette are provided; dark is selected automatically by `prefers-color-scheme`.

Because the tokens are on `:root`, your own markup can consume them for a consistent look without importing anything:

```css
.my-button {
  background: var(--bb-color-accent);
  color: var(--bb-color-accent-text);
  border-radius: var(--bb-radius-sm);
  padding: var(--bb-space-2) var(--bb-space-4);
}
```

Force a specific palette by setting `data-bb-theme` on any ancestor (it wins over the media query):

```html
<body data-bb-theme="dark"> ... </body>
```

Call `injectTheme()` yourself to make the tokens available before any component mounts (for example, to theme your page chrome at startup). It is idempotent and SSR-safe: a second call is a no-op, and it returns silently when there is no `document`:

```typescript
import { injectTheme } from 'aws-cdk-blocks/ui';

injectTheme();
```

`THEME_CSS` (the stylesheet as a string) and `THEME_STYLE_ID` (the `<style>` element's id) are also exported for hosts that bundle the CSS through a build step or assert against it in tests.

## Session-cookie security policy (`/cookies`)

For the author of a custom auth Building Block. `Auth` selects its session cookie's `SameSite` / `Secure` / `Partitioned` attributes with this helper, and a custom auth BB should too. Given `{ crossDomain, isLocalhost }` it returns:

| `crossDomain` | `isLocalhost` | attributes |
|---|---|---|
| `false` (default) | `false` | `SameSite=Lax; Secure` |
| `false` | `true` | `SameSite=Lax` |
| `true` | `false` | `SameSite=None; Secure; Partitioned` |
| `true` | `true` | `SameSite=None; Secure` |

| Function | Returns |
|---|---|
| `buildCookieSecurityAttrs(input)` | The attributes as a string, for a BB that assembles `Set-Cookie` by hand. |
| `resolveCookieSecurity(input)` | The attributes as an object, for a BB that passes a structured cookie config. |
| `isLocalDevRequest(ctx)` | The per-request `isLocalhost` input: `true` only when the process is local (`getDeploymentType()` from `@aws-cdk-blocks/core` is `'local'`) and the request comes from a loopback origin. Always `false` on deployed compute, so a request header such as `Origin: http://localhost` cannot drop `Secure` or `Partitioned`. |
| `isLoopbackRequest(ctx)` | The header check on its own (`localhost`, `127.0.0.1`, `[::1]`). |
| `isInsecurePublicOrigin()` | The `plainHttpOrigin` input, derived from the front door's own scheme (`BLOCKS_PUBLIC_ORIGIN` starting with `http://`), never from a request header. |

The optional `plainHttpOrigin` input marks a deployed front door served over plain HTTP (an ALB with no certificate). `Auth` passes it for every cookie it sets.

- In a sandbox deploy, the same-origin `Lax` cookie drops `Secure`, which a browser would otherwise discard over HTTP.
- Outside a sandbox (`getDeploymentType()` is `'production'`), `resolveCookieSecurity` and `buildCookieSecurityAttrs` throw `AuthErrors.InsecureTransport` (`InsecureTransportException`) instead, so no session is issued without `Secure`.
- The one opt-out outside a sandbox is the front door's `allowPlainHttp: true`, for a trusted network path only. The cookie then drops `Secure` as in a sandbox.
- A clearing cookie (`clearing: true`, `Max-Age=0`) is never refused, so sign-out still clears the cookie.
- The cross-domain cookie is unchanged: the API's own HTTPS response sets it.
