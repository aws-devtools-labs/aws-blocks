# Agent Guide

## Quick Reference

- **Backend:** `aws-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'aws-blocks'`
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **AWS Blocks docs** ship inside the `@aws-blocks/blocks` package. Find the docs folder once: `node -p "require('path').dirname(require.resolve('@aws-blocks/blocks/docs/README.md'))"` (fallback: `node_modules/@aws-blocks/blocks/docs`). Read everything relative to it: `README.md` (dev guide + catalog + decision tree — start here), then `<block>/README.md`, plus `<block>/API.md` and `<block>/DESIGN.md` where present.

## Framework model

These are the load-bearing facts about how a Blocks app fits together. Knowing them up front means you do **not** have to reverse-engineer the wiring or read every block doc before you can build.

### Backend defines APIs; the frontend imports the same names as a typed client

- The backend (`aws-blocks/index.ts`) declares each API with `new ApiNamespace(scope, '<name>', (context) => ({ ...methods }))`, and auth with `auth.createApi()`. You `export` them (e.g. `export const api = …`, `export const authApi = auth.createApi()`).
- The frontend imports those **same export names** from `'aws-blocks'`:

  ```ts
  import { api, authApi } from 'aws-blocks';
  const todos = await api.listTodos();          // typed, awaited call
  ```

  At runtime that import resolves to an auto-generated **client proxy** (`aws-blocks/client.js`), not the server module — the types come from your backend, the transport is injected. **The JSON-RPC transport is invisible: never build request payloads by hand or `fetch()` the API directly** (only for one-off connectivity troubleshooting — see **Calling the API directly** below). Just import the namespace and call the method.
- **Pitfall:** do not `import ... from '../aws-blocks/index.ts'` in a script/test to call the API — that gives you the *server* definition object, which behaves differently from the client. Import from `'aws-blocks'` (the package name) so you get the client, exactly as `src/` does.

### Methods are namespaced

A call is always `namespace.method(...)` — e.g. `api.createTodo(title)`, `api.listTodos()`. The namespace is the name the backend **exports** it under in `aws-blocks/index.ts` — `export const api = new ApiNamespace(scope, 'api', …)` is called as `api.*` — not the second argument to `new ApiNamespace(…)` (keep the two the same to avoid confusion). A bare method name with no namespace will not resolve. (Auth is the same shape but pre-built: `authApi = auth.createApi()` exposes `getAuthState`/`setAuthState` — sign-up is `authApi.setAuthState({ action: 'signUp', … })`, not a bare `signUp`.)

### Auth is a Building Block, not hand-rolled

There is one auth block, `Auth`, imported from `@aws-blocks/blocks`. One options object configures every sign-in method: email + password (on by default), `socialProviders`, `oidcProviders` and `samlProviders`. Full docs: `bb-auth/README.md` in the docs folder (also `node_modules/@aws-blocks/bb-auth/README.md`).

```ts
// aws-blocks/index.ts
import { ApiNamespace, Auth, Scope } from '@aws-blocks/blocks';
const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  users: { groups: ['admins'] },                       // optional: groups for requireRole
  // Local dev only: no email is sent, so log the codes. Ignored on AWS (Cognito emails them).
  codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
export const authApi = auth.createApi();               // the state machine the sign-in UI drives
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async myNotes() {
    const user = await auth.requireAuth(context);      // 401 NotAuthenticatedException if signed out
    return user.userSub;                               // key per-user data on userSub
  },
  async adminReport() {
    await auth.requireRole(context, 'admins');         // 403 NotAuthorizedException if not in the group
  },
}));
```

- **Gate every method that needs a user.** API methods are public by default: call `await auth.requireAuth(context)` (or `auth.requireRole(context, '<group>')`) at the top. `auth.getCurrentUser(context)` returns the user or `null` when you only want to branch.
- **Pass options inline.** The block narrows its types to the literal options: `requireRole` accepts only declared `users.groups`, and methods your configuration doesn't enable are compile errors. Don't route the options through a variable typed `AuthOptions`.
- **Sign-up always confirms the email address with a 6-digit code.** With `emailPassword.autoSignIn` (on by default) the user is signed in once they enter it — no second password entry — but the code is always required. Locally the code goes to `codeDelivery` and to `.bb-data/<scope id>-<auth id>/last-code.json` (e.g. `.bb-data/my-app-auth/last-code.json`); once deployed, Amazon Cognito emails it (its default sender is limited to 50 emails a day).
- **The flow over `authApi`** (what the `Authenticator` does for you, and what tests call): `setAuthState({ action: 'signUp', username, password, email })` → state `confirmingSignUp`; `setAuthState({ action: 'confirmSignUp', username, code })`; `setAuthState({ action: 'autoSignIn', username })` → `signedIn`. Later: `{ action: 'signIn', username, password }` and `{ action: 'signOut' }`. By default (`users.signInWith: ['username', 'email']`) users choose a username, which must not look like an email address, and can also sign in with their email once it is confirmed. With `users: { signInWith: ['email'] }` the email *is* the username (omit `email`), and `user.username` is an id Cognito generates — show `user.displayName` (on `AuthState.user` / `onAuthChange`, the email) and read the address server-side from `user.attributes.email`.
- **Errors cross the wire by name.** Match them with `isBlocksError(e, 'NotAuthenticatedException')` (from `@aws-blocks/blocks/client` on the frontend) or `isAuthError(e, AuthErrors.NotAuthenticated)` on the backend.
- **Decide `users.signInWith` and custom attributes before the first deploy** — Cognito can't change them on an existing user pool. The first synth writes a baseline under `aws-blocks/baselines/` (commit it); from then on synth refuses such a change. **Never change the block's id** (`'auth'`) or its scope after deploying: that creates a new, empty user pool and removes the old one along with its users.

On the frontend, mount the ready-made UI from `@aws-blocks/blocks/ui` — it renders sign-up, the code step and sign-in, and submits the automatic sign-in for you:

```ts
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
authContainer.appendChild(Authenticator(authApi));
onAuthChange(authApi, (user) => { /* re-render for signed-in/out */ });
```

### The deployed frontend finds the backend on its own

You do **not** wire an API URL into the frontend. The imported client resolves the API endpoint itself at runtime: locally, the dev server serves the backend and its config together (`npm run dev` in a fresh app, or `npm run dev:server` when Blocks was added to an existing project; it exposes `/.blocks-sandbox/config.json`); once deployed, the client reads the config served from the hosting origin, where the frontend and API sit same-origin. So build against the imported client and let the framework resolve the URL — don't hardcode one or curl-hunt for the API base.

### Minimal end-to-end example

```ts
// aws-blocks/index.ts (backend)
import { ApiNamespace, Scope } from '@aws-blocks/blocks';
const scope = new Scope('my-app');
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async ping(name: string) { return { message: `hi ${name}` }; },
}));
```

```ts
// src/index.ts (frontend)
import { api } from 'aws-blocks';
const res = await api.ping('world');   // { message: 'hi world' }
```

## Workflow

1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e` — starts a dev server automatically if one isn't running
3. For faster iteration: run `npm run dev &` in the background, then run `npm run test:e2e` repeatedly (reuses the running server)
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

### Calling the API directly (troubleshooting only)

If you do need to hit the API without the typed client (e.g. checking a deployed app without a browser): **every namespace shares one endpoint**, `POST <origin>/aws-blocks/api` (locally `http://localhost:3000/aws-blocks/api`). The namespace goes in the JSON-RPC `method` field, not the URL: there are no per-namespace paths like `/aws-blocks/authApi`, and anything after `/aws-blocks/api` in the path is ignored. The namespace is the **exported variable name** in `aws-blocks/index.ts` (`export const api = …` → `api`), not the 2nd `ApiNamespace` argument.

```bash
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.<yourMethod>","params":[],"id":1}'
```

- `method` is `"<exportName>.<method>"` — use a method your `aws-blocks/index.ts` actually defines. If the app exports `authApi = auth.createApi()`, auth calls are `"authApi.getAuthState"` etc. A wrong name returns `-32601 Method not found` listing the available namespaces.
- `params` is a positional array.
- Errors return HTTP `200` with an `{"error":{...}}` body — check the body, not the status.
- Auth is an `HttpOnly` session cookie: save it on sign-in with `curl -c cookies.txt` and resend it with `-b cookies.txt`.
- More examples: `TROUBLESHOOTING.md` in the docs folder (see the **AWS Blocks docs** bullet above).

## Rules

- **Use Building Blocks** for all persistence and cloud abstractions — never local files, in-memory arrays, or local databases.
- **To store data, reach for a storage Building Block** — `KVStore` for key–value, `DistributedTable` for a queryable table (rows + indexes). Both are constructed with a `Scope` and used inside your API methods; read their `README.md`/`API.md` (see the docs pointer above) for the exact API. The full catalog (auth, files, realtime, email, scheduled/async work, …) is in the docs `README.md`.
- **The framework model above covers the common path.** Read a block's own docs (`README.md`, then `API.md` / `DESIGN.md` where present) when you need a block's specific API surface — not every block has all three, so a missing file is not an error (see the **AWS Blocks docs** bullet for where the docs folder lives).

## Deploying (requires AWS credentials)

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources

On success `npm run deploy` prints one machine-readable line last — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`). Grep that one line for "deploy finished + where it lives"; don't poll CloudFormation or hunt the URL out of the streamed output.
