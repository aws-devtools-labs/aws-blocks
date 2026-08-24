# Native Bindings Test App

Test backend for native client bindings (Swift, Kotlin, Dart). Exercises the Building Blocks that native SDKs consume.

## Blocks Included

| Block | Purpose |
|-------|---------|
| **AuthBasic** | Username/password auth with session cookies |
| **AuthCognito** | AWS Cognito — sign-up, sign-in, MFA, groups, attributes |
| **AuthOIDC** | OIDC sign-in with stub IdP, relay origins for native custom-scheme redirects |
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

**AuthBasic** — Cookie-based sessions. Native clients call:
- `POST /aws-blocks/api` with method `basicSignUp`, `basicSignIn`, `basicSignOut`

**AuthCognito** — Token-based. Native clients call:
- `cognitoSignUp`, `cognitoConfirmSignUp`, `cognitoSignIn`, etc.
- Verification codes are printed to the server terminal

**AuthOIDC** — Redirect-based with relay support for native apps:
- Relay origins configured: `nativebindings://auth`, `com.example.nativebindings://auth`
- Native clients use the relay flow: get authorize params, open system browser, receive callback on custom scheme

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

Requires AuthBasic sign-in:
- `api.createTodo(title, priority)`, `api.listTodos(sortBy?)`, `api.getTodo(todoId)`
- `api.updateTodo(todoId, updates)`, `api.deleteTodo(todoId)`

## Clearing Local Data

```bash
rm -rf .bb-data
```

Then restart the dev server.
