# Native Bindings Test App

Test backend for native client bindings (Swift, Kotlin, Dart). Exercises the Building Blocks that native SDKs consume.

## Blocks Included

| Block | Purpose |
|-------|---------|
| Auth (`auth-basic`) | Email + password with session cookies; sign-up is confirmed with an emailed code |
| Auth (`auth-cognito`) | Email + password with a password policy and groups (`admins`, `users`) |
| Auth (`auth-oidc`) | OIDC sign-in through the local stub IdP with two providers (`google`, `github2`), relay origins for native custom-scheme redirects (no user pool) |
| Auth (`auth-sso`) | A second federated block (stub provider `corp`) whose sign-in routes live under `/cdk-blocks/auth/sso/` |
| Realtime | WebSocket pub/sub (cursor tracking) |
| FileBucket | S3 file storage with presigned upload/download handles |
| KVStore | Key-value storage |
| KVStore (with a `schema` and a `key`) | Structured data (todos) with indexes |

## Setup

```bash
# From the repo root
npm install
npm run build

# Start the dev server
cd test-apps/native-bindings
npm run dev
```

The dev server starts at:
- **Client (Vite):** http://localhost:3000
- **API server:** http://localhost:3001

## Project Structure

```
native-bindings/
├── cdk-blocks/
│   ├── index.ts          ← Backend definition (all blocks + API methods)
│   ├── index.cdk.ts      ← CDK entry
│   ├── index.handler.ts  ← Lambda handler entry
│   ├── client.js         ← Auto-generated client proxy
│   ├── package.json
│   └── scripts/          ← dev server, sandbox, deploy, destroy, seed
├── src/
│   ├── index.ts          ← Web UI client code
│   └── styles.css
├── index.html
├── package.json
├── tsconfig.json
├── cdk.json
└── vite.config.ts
```

## Native Client Integration

### Base URL

Point native SDKs at the API server base URL:
- **Local dev:** `http://localhost:3001`
- **Deployed sandbox:** The API Gateway URL

### Auth Flows

Errors cross the wire by name: the canonical `AuthErrors` names (`NotAuthenticatedException`, `NotAuthorizedException`, `CodeMismatchException`, …) in the JSON-RPC `error.data.name`.

**Email + password (`auth-basic`)** — cookie sessions. Every sign-up confirms the email address with a code, and confirming it signs the user in (auto sign-in). Native clients call:
- `basicSignUp(username, password, email)` → `basicGetLastCode(username)` (local dev server only) → `basicConfirmSignUp(username, code)`
- `basicSignIn`, `basicSignOut`, `basicCheckAuth`, `basicRequireAuth`, `basicGetCurrentUser`, `basicResendSignUpCode`

**Cognito-style (`auth-cognito`)** — the same flow with a password policy and groups:
- `cognitoSignUp`, `cognitoGetLastCode`, `cognitoConfirmSignUp`, `cognitoSignIn` (returns `Auth`'s `SignInResult`), `cognitoRequireRole`; `cdk-blocks/index.ts` has every `cognito*` method.

Sign-up codes:
- Local: no email is sent. The backend's `codeDelivery` hook keeps each code; `*GetLastCode` returns it and the dev-server console prints it.
- Deployed: Cognito emails the code and `*GetLastCode` returns `null`. The native suites sign in a pre-provisioned user instead. Seed it into the stack's user pools after deploying:

```bash
AWS_REGION=<region> BLOCKS_STACK_NAME=<stack> npm run seed:cognito
```

**OIDC (`auth-oidc`)** — redirect-based with relay support for native apps, through `Auth`'s stub IdP ([`Auth` README](../../packages/bb-auth/README.md)):
- Relay origins configured: `nativebindings://auth`, `com.example.nativebindings://auth`
- Native clients use the relay flow against the block's routes: `POST /cdk-blocks/auth/authorize-params/google`, open the authorize URL, receive the callback on the custom scheme, then `POST /cdk-blocks/auth/exchange` (sets the session cookie)
- Two providers, `google` and `github2`, so `getAuthState()` lists two `signIn:<id>` actions. `github2` is always the stub, also when `google` federates a real IdP.
- This test app always deploys as a sandbox, and `Auth` allows `stubIdp()` in local development and sandbox deployments only, so a deployed backend serves the stub too. The native OIDC suites run against it with `RUN_OIDC=1`.
- A sandbox stub lets anyone sign in as its users.

**Real IdP (optional)** — federate a real IdP instead of the stub on a deployed backend:
1. Set `NATIVE_E2E_OIDC_ISSUER` and `NATIVE_E2E_OIDC_CLIENT_ID` when you deploy. The `google` provider then federates that IdP as a public PKCE client.
2. Run the native OIDC suites with `RUN_OIDC=1`.
3. The IdP must complete authorization without a login page and accept the sandbox's `/cdk-blocks/auth/callback` redirect URI; `.github/workflows/native-sdk-e2e.yml` lists the requirements.

**Second federated block (`auth-sso`)**: a `store: 'builtin'` block with one stub provider, `corp`.
- Exports: `ssoOidcApi` (`createOidcApi()`: `getClient()` returns its native OIDC client) and `ssoAuthStateApi` (`createApi()`: its sign-in state machine).
- Routes: two blocks with `providers` can't share sign-in routes, so this one sets `redirects.callbackPath` to `/cdk-blocks/auth/sso/return` and `redirects.signOutPath` to `/cdk-blocks/auth/sso/signout`. Its other routes sit beside the callback: `/cdk-blocks/auth/sso/{authorize-params/<id>, exchange, session, signin/<id>}`.
- `getAuthState()` shows the `signin/<id>` route as the `signIn:corp` action's URL, and the signed-in `signOut` action's URL is the `signOutPath`.
- The client from `ssoOidcApi.getClient()` carries these paths, and the callback is deliberately not named `callback`, so a native client that assumes the default names fails here.
- It accepts the same relay origins as `auth-oidc`, keeps its own session cookie, and has `api.ssoRequireAuth` / `api.ssoGetCurrentUser` to check a sign-in.
- Its stub is keyed `corp` because a stub IdP's routes are keyed by provider key alone, so two blocks can't both serve a `google` stub.

**What the native e2e suites can cover here**, per federated block:
- relay sign-in through any provider with the client from `oidcAuthApi.getClient()` or `ssoOidcApi.getClient()`, then `GET <base>/session` (`200 {user}`, or `401` when signed out);
- sign-out through `POST <signOutPath>?format=json`, which returns `200 {logoutUrl}` (the stub IdP's logout URL), or `200 {}` when the block has no session;
- `getAuthState()` / `setAuthState()` on each state-machine namespace (`authBasicApi`, `authCognitoApi`, `oidcAuthStateApi`, `ssoAuthStateApi`);
- the blocks stay separate: signing out of `auth-sso` leaves `auth-oidc` signed in (`/cdk-blocks/auth/sso/session` is `401`, `/cdk-blocks/auth/session` is still `200`), and while only `auth-oidc` is signed in, `api.ssoRequireAuth` throws `NotAuthenticatedException` and `api.ssoGetCurrentUser` returns `null`;
- `provider` on `api.oidcRequireAuth` / `api.ssoRequireAuth` names the provider that signed in (`github2`, `corp`);
- `GET <base>/session` on a base with no block (for example `/cdk-blocks/auth/none/session`) is `404`, the case where a client's `restore()` should throw;
- a provider the client lists but the block lacks (`POST /cdk-blocks/auth/sso/authorize-params/github2`) is `404` with an empty body, so a client sees an HTTP error rather than a named one.

`503 SignOutIncompleteException` (the cookie cleared but the server-side session not removed) can't be produced against this backend; cover it with unit tests.

**Bearer tokens are not configured.** Native auth is cookie-only for now, so no block here sets `allowBearerAuth`:
- Exchange returns no tokens and the session cookie carries the sign-in.
- Refresh (`<base>/exchange/refresh`) answers `404` on every block.
- To cover bearer later, turn it on in its own block rather than on `auth-oidc`, so the cookie suites keep running unchanged.
- A refresh there needs `{refreshToken, provider}` when the block has two or more providers (as `auth-oidc` does), and returns `expiresIn` in seconds.
- With the stub IdP the refresh token rotates, and reusing the old one returns `401` on the local dev server. On a deployed sandbox that check is best-effort, and a real IdP may not rotate.

### Realtime (WebSocket)

1. Call `api.realtimeGetChannel()` to get a channel descriptor
2. Connect to the WebSocket URL in the descriptor with the provided token
3. Subscribe to cursor events: `{ userId, x, y, color }`

### File Storage (Presigned URLs)

- **Upload:** Call `api.fileCreateUploadHandle(path, contentType?)` → returns `{ __blocks: 'file-bucket/upload', url, contentType }`; `PUT` the body to `url` with that `Content-Type`
- **Download:** Call `api.fileGetHandle(path)` → returns `{ __blocks: 'file-bucket/download', url }` for GET request

### KV Store

- `api.kvGet(key)`, `api.kvPut(key, value)`, `api.kvDelete(key)`, `api.kvScan()`

### Todos (KVStore with a `schema` and a `key`)

Requires a sign-in on the email + password block (`auth-basic`). Todos are keyed on the caller's `userSub`, so each user lists, reads and changes only their own:
- `api.createTodo(title, priority)`, `api.listTodos(sortBy?)`, `api.getTodo(todoId)`
- `api.updateTodo(todoId, updates)`, `api.deleteTodo(todoId)`

A deployed stack whose todos table is keyed on `userId` cannot be updated in place: destroy it (`npm run destroy` or `npm run sandbox:destroy`) and deploy again. Its todos are lost.

## Clearing Local Data

```bash
rm -rf .cdk-blocks/local/data .bb-data
```

Then restart the dev server.
