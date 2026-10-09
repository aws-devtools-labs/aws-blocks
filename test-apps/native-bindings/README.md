# Native Bindings Test App

Test backend for native client bindings (Swift, Kotlin, Dart). Exercises the Building Blocks that native SDKs consume.

## Blocks Included

| Block | Purpose |
|-------|---------|
| **Auth** (`auth-basic`) | Email + password with session cookies; sign-up is confirmed with an emailed code |
| **Auth** (`auth-cognito`) | Email + password with a password policy and groups (`admins`, `users`) |
| **Auth** (`auth-oidc`) | OIDC sign-in through the local stub IdP, relay origins for native custom-scheme redirects (no user pool) |
| **Realtime** | WebSocket pub/sub (cursor tracking) |
| **FileBucket** | S3 file storage with presigned upload/download handles |
| **KVStore** | Key-value storage |
| **DistributedTable** | Structured data (todos) with indexes |

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
├── aws-blocks/
│   ├── index.ts          ← Backend definition (all blocks + API methods)
│   ├── client.js         ← Auto-generated client proxy
│   ├── package.json
│   └── scripts/          ← dev server, sandbox, deploy, destroy
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
- **Sandbox/Production:** The deployed API Gateway URL

### Auth Flows

All three auth blocks are `Auth` (`@aws-blocks/bb-auth`). Errors cross the wire by name — the canonical `AuthErrors` names (`NotAuthenticatedException`, `NotAuthorizedException`, `CodeMismatchException`, …) in the JSON-RPC `error.data.name`.

**Email + password (`auth-basic`)** — cookie sessions. Every sign-up confirms the email address with a code, and confirming it signs the user in (auto sign-in). Native clients call:
- `basicSignUp(username, password, email)` → `basicGetLastCode(username)` (local dev server only) → `basicConfirmSignUp(username, code)`
- `basicSignIn`, `basicSignOut`, `basicCheckAuth`, `basicRequireAuth`, `basicGetCurrentUser`, `basicResendSignUpCode`

**Cognito-style (`auth-cognito`)** — the same flow with a password policy and groups:
- `cognitoSignUp`, `cognitoGetLastCode`, `cognitoConfirmSignUp`, `cognitoSignIn` (returns `Auth`'s `SignInResult`), `cognitoRequireRole`, etc.

Locally no email is sent: the backend's `codeDelivery` hook keeps each code, which `*GetLastCode` returns and the dev-server console prints. Against a deployed backend Cognito emails the code and `*GetLastCode` returns `null`, so the native suites sign in a pre-provisioned user instead — seed it into the stack's user pools after deploying:

```bash
AWS_REGION=<region> BLOCKS_STACK_NAME=<stack> npm run seed:cognito
```

**OIDC (`auth-oidc`)** — redirect-based with relay support for native apps, through `Auth`'s stub IdP. The stub is local-only by default (`Auth` refuses to synthesize a `stubIdp()` provider); this test app opts in with `stubIdp({ unsafeAllowDeployed: true })`, so a deployed backend serves the stub too and the native OIDC suites run against it with `RUN_OIDC=1`. Never copy that into a real app — a deployed stub lets anyone sign in as its users:
- Relay origins configured: `nativebindings://auth`, `com.example.nativebindings://auth`
- Native clients use the relay flow against the block's routes: `POST /aws-blocks/auth/authorize-params/google`, open the authorize URL, receive the callback on the custom scheme, then `POST /aws-blocks/auth/exchange` (sets the session cookie)
- Deployed with a real IdP (optional): set `NATIVE_E2E_OIDC_ISSUER` and `NATIVE_E2E_OIDC_CLIENT_ID` when you deploy, and the `google` provider federates that IdP instead of the stub (a public PKCE client); the native OIDC suites then run against it with `RUN_OIDC=1`. The IdP must complete authorization without a login page and accept the sandbox's `/aws-blocks/auth/callback` redirect URI; `.github/workflows/native-sdk-e2e.yml` lists the requirements.

### Realtime (WebSocket)

1. Call `api.realtimeGetChannel()` to get a channel descriptor
2. Connect to the WebSocket URL in the descriptor with the provided token
3. Subscribe to cursor events: `{ userId, x, y, color }`

### File Storage (Presigned URLs)

- **Upload:** Call `api.fileCreateUploadHandle(path)` → returns `{ url, fields }` for multipart upload
- **Download:** Call `api.fileGetHandle(path)` → returns `{ url }` for GET request

### KV Store

Simple key-value CRUD:
- `api.kvGet(key)`, `api.kvPut(key, value)`, `api.kvDelete(key)`, `api.kvScan()`

### Todos (DistributedTable)

Requires a sign-in on the email + password block (`auth-basic`). Todos are keyed on the caller's `userSub`, so each user lists, reads and changes only their own:
- `api.createTodo(title, priority)`, `api.listTodos(sortBy?)`, `api.getTodo(todoId)`
- `api.updateTodo(todoId, updates)`, `api.deleteTodo(todoId)`

> **Upgrading a deployed stack:** todos are now keyed on the owner's `userSub` instead of `userId`. A table's key can't change in place, so a stack deployed from an earlier version of this test backend fails to update — destroy it (`npm run destroy` or `npm run sandbox:destroy`) and deploy again. Existing todos are not carried over.

## Clearing Local Data

```bash
rm -rf .bb-data
```

Then restart the dev server.
