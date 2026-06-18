# @aws-blocks/bb-auth-basic

Simple username/password authentication with JWT sessions, password policy, and optional code-confirmed signup and password reset.

**When to use:** Prototyping, internal tools, MVPs, or apps that don't need OAuth/OIDC complexity.

**When NOT to use:** For social sign-in (Google, GitHub), use `AuthOIDC`. For MFA, user groups, or custom user attributes, use `AuthCognito`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quick Start

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { AuthBasic } from '@aws-blocks/bb-auth-basic';

const scope = new Scope('my-app');
const auth = new AuthBasic(scope, 'auth', {
  sessionDuration: 86400,
  passwordPolicy: { minLength: 8, requireDigits: true },
  // Optional: enable code-confirmed signup and password reset
  codeDelivery: async (username, code) => {
    await sendEmail(username, `Your verification code: ${code}`);
  },
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getProfile() {
    const user = await auth.requireAuth(context);
    return { username: user.username, createdAt: user.createdAt };
  },
}));

// Export the state machine API for the Authenticator component
export const authApi = auth.createApi();
```

> The client namespace is taken from the **export name** you choose here (so `import { authApi } from 'aws-blocks'` matches); the `'auth'` label inside `createApi()` is internal and does not affect the wire namespace.

## API

```typescript
const auth = new AuthBasic(scope, id, options?)
```

### Server-Side Methods

| Method | Returns | Description |
|---|---|---|
| `requireAuth(context)` | `Promise<AuthBasicUser>` | Require auth. Throws 401 (`SessionExpiredException`) if not signed in. |
| `checkAuth(context)` | `Promise<boolean>` | Check if signed in. |
| `getCurrentUser(context)` | `Promise<AuthBasicUser \| null>` | Get current user or null. |
| `signUp(username, password)` | `Promise<void>` | Register a new user. If `codeDelivery` is set, user is unconfirmed until code is verified. |
| `confirmSignUp(username, code)` | `Promise<void>` | Confirm signup with verification code. Only when `codeDelivery` is set. |
| `signIn(username, password, context)` | `Promise<AuthBasicUser>` | Authenticate and set session cookie. Rejects unconfirmed users. |
| `signOut(context)` | `Promise<void>` | Clear session cookie. |
| `resetPassword(username)` | `Promise<void>` | Send a password reset code. Only when `codeDelivery` is set. |
| `confirmResetPassword(username, code, newPassword)` | `Promise<void>` | Complete password reset with verification code. |
| `createApi()` | `ApiNamespace` | Create the state machine API for the Authenticator component. |

**Action input shape:** `createApi()` returns the state-machine API. `setAuthState` takes a single FLAT discriminated input — `{ action, ...fields }`, never a nested `{ action, data: {...} }`. Examples: `{ action: 'signIn', username, password }`, `{ action: 'signUp', username, password }`, `{ action: 'confirmSignUp', username, code, password }`, `{ action: 'resetPassword', username }`, `{ action: 'confirmResetPassword', username, code, newPassword }`. See the `AuthActionInput` type in `@aws-blocks/auth-common`.

**Note:** `buildApi()` is deprecated — use `createApi()`.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `sessionDuration` | `number` | `86400` (24h) | Session duration in seconds. |
| `passwordPolicy` | `PasswordPolicy` | `{}` | Password requirements. |
| `codeDelivery` | `(username, code) => Promise<void>` | — | Code delivery callback. Enables confirmed signup and password reset. |
| `logger` | `ChildLogger` | — | Optional logger for internal operations. When omitted, a default Logger at error level is created. |
| `crossDomain` | `boolean` | `false` | Set to `true` when the frontend and API are on different registrable domains (e.g. frontend on Vercel, API on AWS). Switches the session cookie to `SameSite=None; Secure; Partitioned`. |

### Password Policy

| Field | Type | Default | Description |
|---|---|---|---|
| `minLength` | `number` | `8` | Minimum password length. |
| `requireUppercase` | `boolean` | `false` | Require uppercase letter. |
| `requireLowercase` | `boolean` | `false` | Require lowercase letter. |
| `requireDigits` | `boolean` | `false` | Require digit. |
| `requireSpecialChars` | `boolean` | `false` | Require special character. |

### Code Delivery

When `codeDelivery` is provided:
- **Signup** creates the user in an unconfirmed state. The code is delivered via the callback. The user must call `confirmSignUp` before they can sign in.
- **Password reset** is available as a state machine action. The code is delivered via the callback. The user enters the code + new password to complete the reset.
- Verification codes are 6-digit numeric strings, valid for 10 minutes.
- Codes are HMAC-hashed before storage — never stored in plain text.

When `codeDelivery` is **not** provided:
- Signup is immediate (no confirmation step).
- Password reset is not available (the action does not appear in the state machine).

## Error Handling

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { AuthBasicErrors } from '@aws-blocks/bb-auth-basic';

try {
  await auth.signIn('alice', 'wrong', context);
} catch (e) {
  if (isBlocksError(e, AuthBasicErrors.InvalidCredentials)) {
    // bad username or password
  }
}
```

| Error Constant | Name | When |
|---|---|---|
| `AuthBasicErrors.InvalidCredentials` | `InvalidCredentialsException` | Wrong username or password, or unconfirmed user |
| `AuthBasicErrors.UserAlreadyExists` | `UserAlreadyExistsException` | Duplicate username on sign-up |
| `AuthBasicErrors.InvalidPassword` | `InvalidPasswordException` | Password doesn't meet policy |
| `AuthBasicErrors.SessionExpired` | `SessionExpiredException` | `requireAuth` with no/expired session |
| `AuthBasicErrors.InvalidCode` | `InvalidCodeException` | Wrong or expired verification code (signup or reset) |

## UI Components

This package does not include UI components. Use the provider-agnostic Authenticator from `@aws-blocks/auth-common/ui`:

```typescript
import { Authenticator } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi));
```

See the [`auth-common` README](../auth-common/README.md) for full UI component documentation including `AuthenticatedContent`, `onAuthChange`, and `broadcastAuthChange`.

## AuthBasicUser

Extends the common `AuthUser` with:

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | Same as username |
| `username` | `string` | The username |
| `createdAt` | `string` | ISO 8601 creation timestamp |

## Cookies and sessions

The session is an `HttpOnly` cookie holding a signed JWT. By default the cookie is `SameSite=Lax` (plus `Secure` off localhost), which is correct for same-origin apps and the local dev proxy — the common case.

Set `crossDomain: true` only when the frontend and API are served from **different registrable domains** in production (e.g. frontend on Vercel, API on AWS). That switches the cookie to `SameSite=None; Secure; Partitioned` so it survives the cross-site request:

```typescript
const auth = new AuthBasic(app, 'auth', { crossDomain: true });
```

On plain-HTTP localhost the BB drops `Secure` for the `Lax` default and drops `Partitioned` for the cross-domain recipe (CHIPS requires HTTPS).
