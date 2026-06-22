# `@aws-blocks/bb-auth-oidc`

OIDC sign-in gate for AWS Blocks applications. Sessions are long-lived and refresh transparently — users stay signed in past the IdP's ~1-hour ID token TTL, and sign-out actually invalidates the session server-side. Works with Google, GitHub, Okta, Auth0, Microsoft Entra, and any OIDC-compliant identity provider. Pointing at an existing Cognito User Pool is a supported path too.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## Quickstart

Backend (`aws-blocks/index.ts`):

```typescript
import { Scope, ApiNamespace } from '@aws-blocks/core';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { AuthOIDC, google } from '@aws-blocks/bb-auth-oidc';

const app = new Scope('quickstart');

const profiles = new KVStore<{ email: string | null; name: string | null }>(app, 'profiles');

const googleClientId = new AppSetting(app, 'google-client-id', { secret: true });
const googleSecret   = new AppSetting(app, 'google-client-secret', { secret: true });

const auth = new AuthOIDC(app, 'auth', {
	providers: [
		google({
			clientId:     () => googleClientId.get(),
			clientSecret: () => googleSecret.get(),
		}),
	],
	onSignIn: async (user) => {
		await profiles.put(user.userId, { email: user.email, name: user.name });
	},
});

export const api = new ApiNamespace(scope, 'api', (ctx) => ({
	async me() {
		const user = await auth.requireAuth(ctx);
		return profiles.get(user.userId);
	},
}));

export const authApi = auth.createApi();
```

Browser:

```tsx
import { authApi } from 'aws-blocks';

const auth = await authApi.getClient();

<button onClick={() => auth.signIn('google')}>Sign in with Google</button>
<button onClick={() => auth.signOut()}>Sign out</button>
```

`signIn()` runs the client-initiated PKCE flow: it navigates to the IdP and, on return, the page calls `auth.handleRedirectCallback()` to complete the exchange. By default the IdP redirects back to the **current page**. For SPAs that handle the callback on a dedicated route, pass `redirectPath`:

```tsx
// IdP returns to /auth-return; that page calls handleRedirectCallback()
auth.signIn('google', { redirectPath: '/auth-return' });
```

`redirectPath` becomes the OAuth `redirect_uri`, so it must be a page your frontend serves **and** a redirect URI registered with the provider (the stub IdP accepts any HTTPS or localhost URL, so local/sandbox needs no registration).

### Which flow to use

- **Server-initiated** (`GET /aws-blocks/auth/signin/<provider>` — a link or the `<Authenticator>` button): the backend owns the callback and sets the session cookie. This is the default for **same-origin** apps (frontend and API on one origin: local dev, single deployed origin, or the sandbox front door).
- **Client PKCE** (`auth.signIn()` above): the browser handles the callback and POSTs to `/aws-blocks/auth/exchange`. Use it for SPAs, and required when the frontend and API are on **different origins**. Same-origin SPAs can use it too, but must pass a frontend `redirectPath` (the default current-page redirect avoids the backend `/aws-blocks/auth/callback`).
- **Relay** (native/CLI): see [Native sign-in](#relay-flow-for-native-sign-in).

## What the BB provisions

Adding `AuthOIDC` to your app provisions:

- Per-instance `RawRoute` handlers: `/aws-blocks/auth/callback`, `/aws-blocks/auth/signout` (POST only — call via `auth.signOut()`; a GET returns 404), and `/aws-blocks/auth/exchange` (for client-initiated PKCE)
- Per-provider routes: `/aws-blocks/auth/signin/<provider>` (server-initiated kickoff) and `/aws-blocks/auth/authorize-params/<provider>` (client-initiated PKCE discovery; also accepts POST for relay flows)
- A single SSM SecureString parameter for cookie signing
- A DynamoDB table (via `KVStore`) for session storage

All routes derive from `callbackPath` (default `/aws-blocks/auth/callback`). A custom `callbackPath` moves the whole set together — e.g. `callbackPath: '/aws-blocks/auth/real/callback'` puts kickoff at `/aws-blocks/auth/real/signin/<provider>`, exchange at `/aws-blocks/auth/real/exchange`, and so on.

The session store holds refresh tokens and verified claims. The cookie carries an opaque session id that keys into this table. Cost is ~$0.25/month for an idle DynamoDB table, and sessions survive beyond the ID token's ~1 hour TTL via automatic refresh.

## Cookies and sessions

The session cookie is an `HttpOnly`, signed pointer to the server-side session store. By default it is `SameSite=Lax` (plus `Secure` in the AWS runtime; dropped on plain-HTTP localhost in the mock runtime), which is correct for same-origin apps and the local dev proxy.

Set `crossDomain: true` only when the frontend and API are served from **different registrable domains** in production (e.g. frontend on Vercel, API on AWS). That switches the session and pending-auth cookies to `SameSite=None; Secure; Partitioned` so they survive the cross-site request:

```typescript
const auth = new AuthOIDC(app, 'auth', {
	providers: [google({ clientId, clientSecret })],
	crossDomain: true,
});
```

## Core concepts

### `userId = ${iss}:${sub}`

Stable per-human-per-IdP. Use this as a foreign key in your own tables. Signing in with Google and GitHub produces two distinct `userId`s for the same human — identity linking is application-code concern, not the BB's.

### Lifecycle hooks

- `onSignIn(user, ctx)` — fires on every successful sign-in. Throw to fail the sign-in (callback returns 500, no cookie).
- `onSignOut(user, ctx)` — fires on explicit sign-out. Throwing is logged but does not block the cookie clear.

### Session management

Sessions outlive the IdP's ID token — users won't get kicked out every hour. The BB provisions the session storage it needs automatically (no configuration), refreshes the access token in the background when it expires, and coordinates concurrent refreshes across containers via a compare-and-swap protocol so a request burst doesn't pile up on the IdP's token endpoint. Sign-out invalidates the session server-side, not just client-side.

### Provider helpers

- `google({ clientId, clientSecret, scopes? })` — OIDC.
- `github({ clientId, clientSecret, scopes? })` — OAuth 2.0 (no ID token; userinfo fetched + mapped automatically).
- `customOidc({ name, issuerUrl, clientId, clientSecret, scopes?, attributeMapping? })` — any OIDC issuer (Okta, Auth0, Cognito User Pools, Entra).
- `customOauth2({ name, authUrl, tokenUrl, userInfoUrl, clientId, clientSecret, scopes, mapClaims })` — bare OAuth 2.0 with a customer-supplied claim mapper.
- `stubIdp({ name })` — a real, in-process OIDC provider for zero-config local sign-in. Auto-approves with deterministic users, needs no real credentials, and works offline. Explicit opt-in: it only handles sign-in for providers you declare with `stubIdp()`, never as a silent substitute for a real provider. Also what you use for E2E. See [Local development](#local-development).

### Pointing at an existing Cognito User Pool

```typescript
customOidc({
	name: 'cognito',
	issuerUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123',
	clientId:     () => poolClientId.get(),
	clientSecret: () => poolSecret.get(),
});
```

## Local development

A configured provider talks to its **real IdP in every environment, including `npm run dev`**. A `google()` provider hits real Google locally; a `customOidc({ issuerUrl })` provider hits that issuer locally.

At startup each provider logs how it resolved, so the path is never silent:

```
[auth] provider "google" → https://accounts.google.com (real IdP)
[auth] provider "corporate" → AWS Blocks stub IdP (local sign-in, no real credentials)
```

### Running a real provider locally

You take on the same one-time setup a hosted IdP needs in any environment:

- **Redirect URI / HTTPS.** Register the local callback (`http://localhost:3000/aws-blocks/auth/callback`) with the IdP. Google accepts `http://localhost`; Okta, Auth0, Entra, and GitHub need the localhost callback added in their console.
- **Secrets present.** The `clientId` / `clientSecret` closures must resolve to real values in `.bb-data`. If a credential can't resolve, sign-in fails with a `ProviderNotConfigured` error — there's no silent fallback to a fake user.
- **Connectivity.** Sign-in calls the IdP, so it needs network access.

### Sandbox (`npm run sandbox`) and redirect-based sign-in

In sandbox the frontend is served locally while the backend runs as a deployed API Gateway + Lambda. Register the IdP callback against the **front-door** origin (`http://localhost:3000/aws-blocks/auth/callback`), the same as `npm run dev` — not the `execute-api` URL. Sign-in then completes the same way it does locally; no extra configuration is needed.

### Zero-config local sign-in with `stubIdp()`

When you want none of that setup — offline, deterministic, no credentials — use `stubIdp()`:

```typescript
import { AuthOIDC, stubIdp } from '@aws-blocks/bb-auth-oidc';

const auth = new AuthOIDC(app, 'auth', {
	providers: [stubIdp({ name: 'google' })],
});
```

`stubIdp()` is a real, spec-conformant OIDC provider that runs in-process: RS256 signing with a real keypair, a JWKS endpoint, OIDC discovery, the authorization-code grant with PKCE, refresh-token rotation, and RFC 7009 revocation. The engine runs the identical discovery + verify code path it uses against a real IdP. It just signs deterministic local users instead of authenticating a human. It is an explicit choice that sits next to your real providers in the `providers` array — it never silently replaces one. It is also what you use for E2E.

You can mix the two freely; the code is the source of truth in every environment:

```typescript
providers: [
	google({ clientId, clientSecret }),  // real Google everywhere, incl. local
	stubIdp({ name: 'corporate' }),       // AWS Blocks stub everywhere
]
```

#### The login screen and `onAuthorize`

By default, `stubIdp()` serves an interactive account-picker at its `/authorize`
endpoint — you see a real sign-in screen and pick a user, the same shape as signing
in at a hosted IdP. `onAuthorize` decides what happens when an authorize request
lands:

```typescript
stubIdp({
	name: 'google',
	// return a user    → sign in as them, skip the screen
	// return undefined → show the interactive login screen (the default)
	// throw            → deny the authorize (negative-path testing)
	onAuthorize: (req) => req.users.find((u) => u.email === req.loginHint),
})
```

`req` is `{ provider, scopes, redirectUri, state, nonce, loginHint?, users }`, where
`users` is the local identity directory and `loginHint` is the standard OIDC
`login_hint` param. For E2E (no human to click), auto-approve as the first user:

```typescript
stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] })
```

#### Local identities (`users.json`)

By default the directory is a single deterministic user
(`stub-<provider>-user`). To define multiple local identities, drop a
`users.json` array in the instance's mock data dir
(`.bb-data/<auth-id>/users.json`):

```jsonc
[
	{ "sub": "alice", "email": "alice@example.com", "name": "Alice" },
	{ "sub": "bob",   "email": "bob@example.com",   "name": "Bob" }
]
```

Those users populate `req.users` and the login screen's account picker. With no
file, the single default user is used, so existing apps are unchanged.

## Error taxonomy

All errors follow the `<Name>Exception` naming convention and work with `isBlocksError()`.

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { AuthOIDCErrors } from '@aws-blocks/bb-auth-oidc';

try { await auth.requireAuth(ctx); }
catch (e) {
	if (isBlocksError(e, AuthOIDCErrors.NotAuthenticated)) return redirectToSignIn();
	throw e;
}
```

`NotAuthenticated`, `TokenExpired`, `InvalidState`, `InvalidCallback`, `ProviderNotConfigured`, `IdpError`, `InvalidRelay`, `SdkOutdated`.

`SdkOutdated` is surfaced from `/aws-blocks/auth/callback` when a relay state envelope version is unrecognized — the client SDK is older than the backend expects and should be updated.

## Cognito-mediated federation

Delegate the OIDC flow to a Cognito User Pool. Cognito handles PKCE, token verification, MFA, and brute-force protection. Your Lambda only exchanges the code and reads the session.

`cognitoFederated()` takes `AppSetting` instances (not closures) for the IdP credentials — the CDK layer needs to read them at synth time to register the IdP in Cognito via CloudFormation dynamic references.

```typescript
import { AuthOIDC, cognitoFederated } from '@aws-blocks/bb-auth-oidc';
import { AppSetting } from '@aws-blocks/bb-app-setting';

const googleClientId = new AppSetting(app, 'google-client-id', { secret: true });
const googleSecret   = new AppSetting(app, 'google-client-secret', { secret: true });

const auth = new AuthOIDC(app, 'auth', {
	providers: [
		cognitoFederated({
			name: 'google',
			identityProvider: 'Google',
			cognitoDomain: 'myapp',
			region: 'us-east-1',
			clientId:     googleClientId,
			clientSecret: googleSecret,
		}),
	],
});
```

User IDs are stable across engine switches — `userId = ${iss}:${sub}` is derived from the original IdP identity (extracted from Cognito's `identities` claim), not from Cognito's internal UUID.

The CDK layer auto-provisions the Cognito User Pool, App Client, domain, and identity provider registrations. No Cognito CDK code needed.

In local dev (`npm run dev`), `cognitoFederated` is **not available** — Cognito federation needs the deployed User Pool + app-client credentials, which only exist after `npm run sandbox` / `npm run deploy`. Declaring the provider doesn't block local dev, but a cognito-federated sign-in fails fast with a clear message. For local sign-in, add an explicit `stubIdp({ name })` provider (see [Local development](#local-development)); exercise the real Cognito flow in sandbox/deploy.

### When to use Cognito federation vs self-hosted

- **Self-hosted** (`google()`, `customOidc()`): Simpler, cheaper, faster deploys. You own the security surface.
- **Cognito-mediated** (`cognitoFederated()`): Managed security (SOC 2, HIPAA-eligible), MFA on social sign-in, adaptive authentication, brute-force protection. Adds Cognito MAU pricing.

## Native clients (iOS, Android, desktop)

By default, sessions are cookie-only — tokens never reach the client. This is the right choice for web apps. Native clients don't have a cookie store that the IdP understands, so they need bearer tokens.

Enable `allowBearerAuth: true` to get:

- `POST /aws-blocks/auth/exchange` returns `{ user, accessToken, refreshToken, expiresIn }`
- `Authorization: Bearer <accessToken>` is accepted as an alternative to the session cookie
- `POST /aws-blocks/auth/refresh` endpoint is mounted for renewing tokens

```typescript
const auth = new AuthOIDC(app, 'auth', {
	providers: [google({ clientId, clientSecret })],
	allowBearerAuth: true,
});
```

The client stores tokens in the OS keychain (iOS Keychain, Android Keystore, OS-native credential store) and posts the refresh token to `/aws-blocks/auth/refresh` when the access token expires:

```typescript
// Native client — pseudo-code
const { accessToken, refreshToken, expiresIn } = await fetch('/aws-blocks/auth/refresh', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ refreshToken: stored.refreshToken, provider: 'google' }),
}).then(r => r.json());

await keychain.save({ accessToken, refreshToken, expiresIn });
```

**Security tradeoff.** Enabling this exposes tokens to the client runtime. For web apps, prefer the default cookie-only mode so the token never lives in JavaScript's reach.

### Relay flow for native sign-in

Major IdPs (Google, Microsoft Entra, Okta, Auth0) reject custom-scheme redirect URIs (`myapp://auth/callback`) at registration time. Native clients can't register their app scheme directly with the IdP.

The backend's HTTPS callback stays registered with the IdP. After the IdP returns, the backend 302s to the native app's custom-scheme URI with the auth code attached. PKCE stays client-side, the IdP only ever sees an HTTPS URL.

Enable it by declaring `allowedRelayOrigins`:

```typescript
import { AuthOIDC, google, relayOrigin } from '@aws-blocks/bb-auth-oidc';

const auth = new AuthOIDC(app, 'auth', {
	providers: [google({ clientId, clientSecret })],
	allowBearerAuth: true,
	allowedRelayOrigins: [
		relayOrigin('myapp://auth'),           // Android/iOS custom scheme
		relayOrigin('https://oauth.myapp.com'), // off-origin HTTPS helper (optional)
	],
});
```

**How the native SDK drives the flow:**

1. POST `/aws-blocks/auth/authorize-params/<provider>` with `{ csrf, relayTo: 'myapp://auth', appState? }` → server returns `{ authorizeUrl, clientId, scopes, state, nonce }`
2. Open the IdP authorize URL in a system browser with `redirect_uri` set to the **backend's** HTTPS callback (not the custom scheme)
3. User authenticates at the IdP → IdP redirects to `/aws-blocks/auth/callback?code=...&state=...`
4. Backend decodes the signed state envelope, sees the relay target, and issues `302 Location: myapp://auth?code=...&state=...`
5. OS routes the custom-scheme URI back to the native app
6. App extracts `code` + `state`, verifies CSRF, and POSTs to `/aws-blocks/auth/exchange` with the code + PKCE verifier → gets `{ user, accessToken, refreshToken, expiresIn }`

**Implicit allowances** (no `relayOrigin()` entry needed):

- **Loopback** — `http://127.0.0.1:<any-port>` and `http://[::1]:<any-port>`. Covers CLI tools using RFC 8252 §7.3 ephemeral-port pattern.
- **Same-origin** — the backend's own URL.

**Granularity.** Entries match on scheme + host + (port if pinned). Paths on the actual `relayTo` value are preserved through the 302 — the allowlist doesn't pattern-match paths.

**Error handling.** If the IdP returns an error (e.g., user cancels consent), the backend forwards it through the relay: `302 Location: myapp://auth?error=access_denied&error_description=...&state=...`. The native SDK should check for `error` before looking for `code`.



