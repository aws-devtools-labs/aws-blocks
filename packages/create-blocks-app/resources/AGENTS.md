# Agent Guide

## Quick Reference

- **Backend:** `cdk-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'cdk-blocks'`
- **Imports:** backend code imports `Scope`, `ApiNamespace`, `ApiError`, `isBlocksError` and every Building Block class from `aws-cdk-blocks`, along with the block's errors constant where it has one there (e.g. `KVStore`, `KVStoreErrors`; `Realtime`, `Compute` and `Tracer` come without one); browser code and tests import client helpers from `aws-cdk-blocks/client`.
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **Script names:** In an existing project, look in `package.json` under `scripts` for the `aws-cdk-blocks/run` entry with the matching trailing command. Use its actual script name if an overlay preserved an existing name.
- **AWS Blocks docs:** `npm run docs` is the docs command for this app's Building Blocks and AWS Blocks APIs. It answers types, signatures and how a block behaves, so there's no need to open the packages' source unless necessary. With no arguments it lists the blocks; name one or more blocks or APIs to print their docs: `npm run docs KVStore Auth`. A name can be a block, an export, a type, a function, an option or a method (`ApiError`, `AuthState`, `submitAuthAction`, `ifFieldEquals`, `Secret.get`): it prints the import line, the declaration and the docs about it. `--section <topic>` prints the part of a block's docs about a topic (`npm run docs KVStore -- --section local` for how it behaves on your machine), `npm run docs:api KVStore` prints exact signatures, `npm run docs -- --exports [filter]` lists what you can import and from which entry, `npm run docs:search <term>` searches all the docs, and `npm run docs -- --help` shows every option.

## Framework model

These are the load-bearing facts about how a Blocks app fits together. Knowing them up front means you do **not** have to reverse-engineer the wiring or read every block doc before you can build.

### Backend defines APIs; the frontend imports the same names as a typed client

- The backend (`cdk-blocks/index.ts`) declares each API with `new ApiNamespace(scope, '<name>', (context) => ({ ...methods }))`, and auth with `auth.createApi()`; a namespace whose methods need a signed-in user is best declared with `auth.protect(scope, '<name>', { public, methods })` (see below). You `export` them (e.g. `export const api = …`, `export const authApi = auth.createApi()`).
- The frontend imports those **same export names** from `'cdk-blocks'`:

  ```ts
  import { api, authApi } from 'cdk-blocks';
  const todos = await api.listTodos();          // typed, awaited call
  ```

  At runtime that import resolves to an auto-generated **client proxy** (`cdk-blocks/client.js`), not the server module — the types come from your backend, the transport is injected. **The JSON-RPC transport is invisible: never build request payloads by hand or `fetch()` the API directly** (only for one-off connectivity troubleshooting — see **Calling the API directly** below). Just import the namespace and call the method.
- **Pitfall:** do not `import ... from '../cdk-blocks/index.ts'` in a script/test to call the API — that gives you the *server* definition object, which behaves differently from the client. Import from `'cdk-blocks'` (the package name) so you get the client, exactly as `src/` does.

### Methods are namespaced

A call is always `namespace.method(...)` — e.g. `api.createTodo(title)`, `api.listTodos()`. The namespace is the **exported variable name** in `cdk-blocks/index.ts` (`export const api = …` → `api`; `export const authApi = auth.createApi()` → `authApi`), not the 2nd `ApiNamespace` argument. A bare method name with no namespace will not resolve. (Auth is the same shape but pre-built: `authApi` exposes `getAuthState`/`setAuthState` — sign-up is `authApi.setAuthState({ action: 'signUp', … })`, not a bare `signUp`. In browser code, send it as `submitAuthAction(authApi, { action: 'signUp', … })` instead, so the rest of the page sees the result; see **Auth on the frontend**.)

When a request names a call such as `orders.create(...)`, export `const orders = new ApiNamespace(scope, 'orders', …)` and define `create` there. Adding `create` to `api`, or exporting `ordersApi`, does not provide `orders.create`. Update frontend callers and tests to the requested name; keep existing methods unless the request replaces them.

### Errors that reach the client

- Throw `new ApiError(message, status, { name, retriable })` (in `cdk-blocks/`, import `ApiError` and `isBlocksError` from `aws-cdk-blocks`), e.g. `throw new ApiError('Order not found', 404, { name: 'OrderNotFound' })`. The client receives the status, message, `name` and `retriable`. `retriable` defaults to `false`; set `retriable: true` only when retrying the same call can succeed.
- A plain `Error` (even with `name` or `status` set on it) or a thrown non-`Error` reaches the client as an unnamed `500` with the message `Internal error`. Clients match the name, not the message: `isBlocksError(e, 'OrderNotFound')`.
- In client code (`src/` and `test/`), import `ApiError` and `isBlocksError` from `aws-cdk-blocks/client`: there `aws-cdk-blocks` itself exports nothing, because the frontend build and `npm run test:e2e` load its browser entry. A failed call throws an `ApiError`. `isBlocksError(e, name)` narrows `e` to `Error & { name }`, which has no `status`, so check `e instanceof ApiError` before reading `e.status`: `npm run build` type-checks `test/` too.
- `get()` on `KVStore` and `FileBucket` returns `null` for a missing item; it does not throw. When the API promises a not-found error, turn that `null` into an `ApiError`.
- `FileBucket.getUrl()` signs a URL without checking that the file exists, and `delete()` of a missing file succeeds. Call `get()` first when a download or delete must reject a missing file.

### Auth on the frontend

There is one auth block, `Auth`, imported from `aws-cdk-blocks`. One options object configures it: `store` picks where users live — a Cognito user pool (the default: email + password, on by default, plus `providers` entries of `type: 'google'`, `'apple'`, `'facebook'`, `'amazon'`, `'saml'` or `'oidc'`), or `store: 'builtin'` (no user pool: `type: 'oidc'` entries, `github()` and `stubIdp()`, verified by your backend). One block holds one kind of user; password users and backend-verified IdP users need two `Auth` blocks. Full docs: `npm run docs Auth`.

```ts
// cdk-blocks/index.ts
import { ApiNamespace, Auth, Scope } from 'aws-cdk-blocks';
const scope = new Scope('my-app');
const auth = new Auth(scope, 'auth', {
  // Email sign-in, matched ignoring case — fixed once the user pool exists (see below).
  users: { signInWith: ['email'], caseSensitive: false, groups: ['admins'] }, // groups: optional, for requireRole
  // Local dev only: no email is sent, so log the codes. Ignored on AWS (Cognito emails them).
  codeDelivery: async (username, code, purpose) => console.log(`[auth] ${purpose} code for ${username}: ${code}`),
});
export const authApi = auth.createApi();               // the state machine the sign-in UI drives
// Deny by default: `methods` runs only after the session check, with the signed-in user.
export const notesApi = auth.protect(scope, 'notesApi', {
  public: (context) => ({                              // no session needed
    async health() {
      return { ok: true };
    },
  }),
  methods: (context, user) => ({                       // 401 NotAuthenticatedException if signed out
    async myNotes() {
      return user.userSub;                             // key per-user data on userSub
    },
  }),
});
export const adminApi = auth.protect(scope, 'adminApi', {
  methods: () => ({ async adminReport() {} }),
}, { role: 'admins' });                                // 403 NotAuthorizedException if not in the group
// A plain ApiNamespace is public: each method must await its own guard.
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async myProfile() {
    const user = await auth.requireAuth(context);      // 401 NotAuthenticatedException if signed out
    return user.attributes.email;
  },
}));
```

- **Prefer `auth.protect(scope, '<name>', { public: (context) => ({ ... }), methods: (context, user) => ({ ... }) })` for any namespace with signed-in methods.** `methods` runs only after the session check (and the group check, with `{ role }` as the last argument), once per call, with the typed `user`; `public` methods need no session. A signed-out call to anything but a public method gets 401. This way a forgotten guard can't expose a method.
- **In a plain `ApiNamespace`, gate every method that needs a user.** Its methods are public by default: call `await auth.requireAuth(context)` (or `await auth.requireRole(context, '<group>')`) at the top. Always `await` it: a guard that isn't awaited protects nothing, and no lint rule in this project catches the missing `await`. `auth.getCurrentUser(context)` returns the user or `null` when you only want to branch.
- **Pass options inline.** The block narrows its types to the literal options: `requireRole` accepts only declared `users.groups`, and methods your configuration doesn't enable are compile errors. Don't route the options through a variable typed `AuthOptions`.
- **Sign-up always confirms the email address with a 6-digit code.** With `emailPassword.autoSignIn` (on by default) the user is signed in once they enter it — no second password entry — but the code is always required. Locally the code goes to `codeDelivery` and to `.bb-data/<scope id>-<auth id>/last-code.json` (e.g. `.bb-data/my-app-auth/last-code.json`); once deployed, Amazon Cognito emails it (its default sender is limited to 50 emails a day).
- **The flow over `authApi`** (what the `Authenticator` does for you, and what tests call): `setAuthState({ action: 'signUp', username, password, email })` → state `confirmingSignUp`; `setAuthState({ action: 'confirmSignUp', username, code })`; `setAuthState({ action: 'autoSignIn', username })` → `signedIn`. Later: `{ action: 'signIn', username, password }` and `{ action: 'signOut' }`. This app's pool uses `users: { signInWith: ['email'], caseSensitive: false }`: the email *is* the username (omit `email`), it matches ignoring case, and `user.username` is an id Cognito generates — show `user.displayName` (on `AuthState.user` / `onAuthChange`, the email) and read the address server-side from `user.attributes.email`. (Without `signInWith`, the block's default is `['username', 'email']`: users choose a username, which must not look like an email address, and can also sign in with their email once it is confirmed.)
- **`signInWith` and `caseSensitive` are permanent.** Cognito fixes both when the user pool is created; changing them later means a new pool and migrating every user, so the block refuses the change at synth. Decide before the first deploy that holds real users. The email + case-insensitive shape is also what Amplify's client libraries expect, so a frontend can later sign in with them against the same pool (`npm run docs Auth -- --section amplify` prints "Planning to use Amplify client libraries?").
- **Errors cross the wire by name.** Match them with `isBlocksError(e, 'NotAuthenticatedException')` (from `aws-cdk-blocks/client` on the frontend) or `isAuthError(e, AuthErrors.NotAuthenticated)` on the backend.
- **Decide `users.signInWith` and custom attributes before the first deploy** — Cognito can't change them on an existing user pool. The first synth writes a baseline under `cdk-blocks/baselines/` (commit it); from then on synth refuses such a change. **Never change the block's id** (`'auth'`) or its scope after deploying: that creates a new, empty user pool and removes the old one along with its users.

`Auth` supplies the backend only; the frontend must let a user sign in. On the frontend, mount the ready-made UI from `aws-cdk-blocks/ui` — it renders sign-up, the code step and sign-in, and submits the automatic sign-in for you:

- On the backend, define signed-in methods with `auth.protect(...)`, or call `await auth.requireAuth(context)` at the top of each protected method of a plain `ApiNamespace`. Either throws when the user is not signed in.
- On the frontend, use these parts from `aws-cdk-blocks/ui`. Attach them the way your frontend attaches DOM elements.
  - `Authenticator(authApi)`: an element with the sign-in, sign-up and confirm forms.
  - `AuthenticatedContent(authApi, render, fallback?)`: shows `render(user)` for a signed-in user and `fallback` for a signed-out user.
  - `onAuthChange(authApi, callback)`: calls `callback(user)` with the current user, then again each time the user signs in or out through `Authenticator` or `submitAuthAction`. Use it when you render the content yourself.
  - `submitAuthAction(authApi, { action: 'signIn', username, password })`: submits an auth action from your own form, returns the resulting `AuthState`, and notifies `onAuthChange` and `AuthenticatedContent`. A direct `authApi.setAuthState()` call sets the session cookie but notifies nothing on the page, so the UI stays signed out until a reload. Call `setAuthState` directly only in Node tests and scripts.
- `codeDelivery` never skips the code step: every sign-up confirms its email with a code, with or without the hook. Locally the code is written to `.bb-data/<scope id>-<auth id>/last-code.json`, and passed to the hook too; the deployed app ignores the hook and Amazon Cognito emails the code.

When the app is complete, a signed-out user reaches the sign-in form from the first page, the protected content appears after sign-in, and it is hidden again after sign-out.

`Authenticator` emits stable testids. The fields are `authenticator-username` / `authenticator-password` (on an email sign-in pool the username field is labelled Email and takes the address) and the actions `authenticator-action-signIn` / `authenticator-action-signUp` / `authenticator-submit`. `CUSTOMIZING-AUTH-UI.md` is the full contract; social, OIDC and SAML sign-in actions carry a provider suffix, e.g. `authenticator-action-signIn:google`.

### The deployed frontend finds the backend on its own

You do **not** wire an API URL into the frontend. The imported client resolves the API endpoint itself at runtime: locally, the dev server serves the backend and its config together (`npm run dev` in a fresh app, or `npm run dev:server` when Blocks was added to an existing project; it exposes `/.blocks-sandbox/config.json`); once deployed, the client reads the config served from the hosting origin, where the frontend and API sit same-origin. So build against the imported client and let the framework resolve the URL — don't hardcode one or curl-hunt for the API base.

### Minimal end-to-end example

```ts
// cdk-blocks/index.ts (backend)
import { ApiNamespace, Scope } from 'aws-cdk-blocks';
const scope = new Scope('my-app');
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async ping(name: string) { return { message: `hi ${name}` }; },
}));
```

```ts
// src/index.ts (frontend)
import { api } from 'cdk-blocks';
const res = await api.ping('world');   // { message: 'hi world' }
```

### Live data: push with Realtime, or poll safely

For data that changes while the page is open (dashboards, counters, feeds), prefer **push over poll**: the `Realtime` block delivers updates to the browser as they happen. A backend method returns a channel handle (`await rt.getChannel(namespace, channel)`), the frontend calls `subscribe(handler)` on it, and the backend calls `rt.publish(...)` when the data changes. See `npm run docs Realtime` for the full API.

If you poll instead, every open tab calls the backend on a timer: each call is a Lambda invocation and an API Gateway request, so a careless poller wastes money and can hit the stage's rate limit. A safe poller:

1. **Never overlaps calls.** Schedule the next call after the previous one settles: chain `setTimeout`, never a fixed `setInterval`.
2. **Pauses while the tab is hidden.** Stop on `visibilitychange` → `hidden`, and refresh right away on `visible`.
3. **Makes one call per tick.** Add one backend method that returns everything the view shows, not several calls per tick.
4. **Backs off on errors**, up to a ceiling.
5. **Stops on dispose**, and ignores a response that arrives after it.

The typed client has no abort option, so a response can't be cancelled. Rules 1 and 5 make that safe: there is never more than one call in flight, and a late response is dropped.

```ts
// src/poll.ts — replace getDashboard with your own one-call-per-tick method
import { api } from 'cdk-blocks';

type Dashboard = Awaited<ReturnType<typeof api.getDashboard>>;

export function pollDashboard(render: (data: Dashboard) => void, intervalMs = 5_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let stopped = false;
  let failures = 0;

  const visible = () => document.visibilityState === 'visible';

  async function tick(): Promise<void> {
    timer = undefined;
    if (stopped || inFlight || !visible()) return;
    inFlight = true;
    try {
      const data = await api.getDashboard();
      if (stopped) return;
      failures = 0;
      render(data);
    } catch {
      failures++;
    } finally {
      inFlight = false;
    }
    if (stopped || !visible()) return;
    timer = setTimeout(tick, Math.min(intervalMs * 2 ** failures, 60_000));
  }

  function onVisibilityChange(): void {
    if (!visible()) {
      clearTimeout(timer);
      timer = undefined;
    } else if (timer === undefined) {
      void tick();
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
```

Call `const stop = pollDashboard(render)` when the view mounts, and `stop()` when it unmounts.

### Typechecking: `npm run typecheck`

- An app with a `tsconfig.app.json` (the Vite templates) checks the browser code and the backend as separate TypeScript projects: `src/` without Node types, `cdk-blocks/` (through `cdk-blocks/tsconfig.json`) with them. `process` or `Buffer` in `src/` fails with `TS2591`, and a `node:` import with `TS2307`: that code runs in the browser. Keep it in `cdk-blocks/`, or read build-time values with `import.meta.env`.
- Run `npm run typecheck` (`tsc -b --force`), never `npx tsc --noEmit` at the root: that root `tsconfig.json` only lists references, so it checks nothing. `TS6305 ... has not been built` means `tsc` ran without `-b`.
- `TS6307 ... is not listed within the file list of project` means the backend imports a file its project does not include. `npm run docs troubleshooting -- --section TS6307` prints the fix for this and the other errors of the layout.
- A Next.js or backend-only app has one `tsconfig.json` with Node types, and `npm run typecheck` is `tsc --noEmit`.

## Workflow

1. Make changes to backend (`cdk-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e`. Add tests to `test/e2e.test.ts` that call the API the way its existing tests do, and keep its `test.before`/`test.after`: they start a dev server only when nothing answers on the dev port (`package.json` `"blocks.dev.port"`, see step 3), wait until it is ready, and stop only a server they started. For API-only work this replaces a manual dev server plus curl probes. When a test run started its own server, it has stopped it by the time it exits, so there is nothing to stop or check afterwards.
3. For faster iteration, keep one dev server running and rerun tests against it:
   - Start `npm run dev` as a background process — use your harness's background-process feature if it has one, otherwise `npm run dev > dev.log 2>&1 &`. Keep the redirect: without it the background dev server still writes to your shell's output, and it stops at its next log line once that shell or pipe closes. Read `dev.log` for its output.
   - Run `npm run test:e2e` as often as needed; it reuses the server running on the `package.json` `"blocks.dev.port"` (default 3000, or 3001 for a backend-only app), and calls only that server, also after a deploy. To use another port, set it there rather than passing `npm run dev -- --port`, so the tests and `npm run dev:stop` find the same server. To run the tests against a deployed app instead, set `TEST_URL` to the URL its API is under (the frontend URL `npm run deploy` prints, or the API URL without `/aws-blocks/api`).
   - When finished, stop it with `npm run dev:stop` (it signals the dev server's own recorded supervisor by PID). Avoid name-matching kills like `pkill -f tsx` or `killall node`: they also match your own shell/agent process and terminate it.
   - Restart only to check restart or persistence behavior (local data in `.bb-data/` survives restarts). Add no sleeps or port checks: the test setup already waits for readiness.
   - Read a block doc section once. Open `.d.ts` files or source only for a concrete unanswered question or an observed error.
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

### Calling the API directly (troubleshooting only)

If you do need to hit the API without the typed client (e.g. checking a deployed app without a browser): **every namespace is served at one endpoint**, `POST <origin>/aws-blocks/api` (locally `http://localhost:3000/aws-blocks/api`). The namespace goes in the JSON-RPC `method` field: there are no per-namespace paths like `/aws-blocks/authApi`. (The typed client also appends the namespace to the URL — `/aws-blocks/api/<namespace>` — so a gateway can route it; if you use that form, the namespace in the path must match the one in `method`, or the call fails with `-32600` Invalid Request.) The namespace is the **exported variable name** in `cdk-blocks/index.ts` (`export const api = …` → `api`), not the 2nd `ApiNamespace` argument.

```bash
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.<yourMethod>","params":[],"id":1}'
```

- `method` is `"<exportName>.<method>"` — use a method your `cdk-blocks/index.ts` actually defines. If the app exports `authApi = auth.createApi()`, auth calls are `"authApi.getAuthState"` etc. A wrong name returns `-32601 Method not found` listing the available namespaces.
- `params` is a positional array.
- Errors return HTTP `200` with an `{"error":{...}}` body — check the body, not the status.
- Auth is an `HttpOnly` session cookie: save it on sign-in with `curl -c cookies.txt` and resend it with `-b cookies.txt`.
- More examples: `npm run docs troubleshooting` (see the **AWS Blocks docs** bullet above).

## Rules

- **Use Building Blocks** for all persistence and cloud abstractions — never local files, in-memory arrays, or local databases.
- **To store data, use `KVStore`** — for app records you list or query as a collection (todos, notes, orders), give the store a `schema` and a `key`; for values you read and write by one key (settings, flags, caches, sessions, per-user preferences), use it with no options. Decide before you create the store: a store cannot change its key. It is constructed with a `Scope` and used inside your API methods; read its docs (`npm run docs KVStore`, with `--api` for exact signatures) for the exact API. The full catalog (auth, files, realtime, email, scheduled/async work, …) is `npm run docs`.
- **The framework model above covers the common path.** Read a block's own docs (`npm run docs <Block>...`, with `--api` for exact signatures) when you need a block's specific API surface (see the **AWS Blocks docs** bullet).

## Deploying (requires AWS credentials)

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run sandbox:deploy` — deploy backend to AWS once and exit (no watch, no dev server); use this from scripts and CI
- `npm run sandbox:preview` — deploy the sandbox backend plus a hosted preview of the frontend once and exit; prints the preview URL. It is the same stack as `sandbox` / `sandbox:deploy`: a plain sandbox deploy removes the preview, and re-adding it gives a new URL
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources; in a terminal it asks first (`npm run sandbox:destroy -- --yes` skips the question), and without one (CI, an agent's shell) it runs without asking

`npm run deploy` does the whole deploy in one command. A first production deploy can take 10+ minutes. For a human-readable background log, run `npm run deploy -- --output text > deploy.log 2>&1 &` (or use your harness's background-process feature with `--output text`). Use `npm run sandbox:deploy -- --output text` the same way for a first sandbox deploy.

If `npm run sandbox` or `npm run deploy` stops with `AWS credentials could not be verified`, the message names the profile, the deployment Region and the command that fixes it, such as `aws login --profile <name>` or `aws sso login --profile <name>`. Signing in opens a browser and needs the user: ask the user before you run the command, then re-run the npm script. If the message first lists `aws configure set region <region> --profile <name>`, that command changes the user's AWS config: include it when you ask, and run it before the sign-in.

If either command stops with `CDK is not bootstrapped in Region <region> of account <account-id>`, the message includes the command that fixes it: `npx cdk bootstrap aws://<account-id>/<region> --app=`, run from the project directory. Bootstrapping is needed once per account and Region, takes a few minutes, and creates IAM roles and other resources in the user's account: ask the user before you run it, then re-run the npm script.

Before deploying, both commands print `Deployment target: <credentials>, Region <region>`, where the credentials are for example `AWS profile <name>` or `access keys in AWS_ACCESS_KEY_ID`, then the account name and plan. When the credentials are the AWS-managed role of the new AWS sign-up experience, a link to `https://settings.aws.com/billing` follows; other accounts get no link. The deploy does not pause: if the credentials or Region are not the ones the user expects, stop the command (Ctrl-C) and ask. `Account name: not available` or `Account plan: not available` is not an error: the deploy continues. Never change a spend limit yourself. When the output has the billing link, give it to the user, and ask them to verify in AWS Settings that the project they manage matches the CLI deployment target. If the user signs in with `aws login`, the profile Region must be set to the project's Region before sign-in (`aws configure set region <region> --profile <name>`); after changing it, they run `aws login` again.

In text mode, look for `BLOCKS_DEPLOYED url=<frontend> api=<backend>` in `deploy.log` (a backend-only app omits `url=`). Wait for the process to exit successfully. For automation, use `npm run -s deploy > deploy.json` instead: stdout contains the structured result, including the URLs, and progress stays on stderr.

`npm run sandbox:deploy` prints `BLOCKS_DEPLOYED api=<backend>` too. The typed client (`cdk-blocks/client.js`) is generated before the deploy and `.cdk-blocks-sandbox/config.sandbox.json` is written before the line, so once you see it the sandbox is ready. A deploy never changes where `npm run dev`, `npm run test:e2e` or your local scripts point: it records its URL in `.cdk-blocks-sandbox/config.sandbox.json` (`config.production.json` for `npm run deploy`), and only the dev server writes `.cdk-blocks-sandbox/config.json`. To get the API URL alone in a script, run `npm run -s sandbox:deploy -- --query apiUrl`.

If you will immediately self-test the frontend, add `npm run deploy -- --wait-live`: it holds the `BLOCKS_DEPLOYED` line until the new build is actually being served through CloudFront, so a request issued right after the signal returns the new asset rather than a stale cached bundle. Without it, the signal fires as soon as the deploy process exits, which can be a few seconds before the edge finishes serving the new build. Tune the budget with `--wait-live-timeout=<seconds>` (default 180); if it can't confirm within the budget it says so and exits non-zero instead of printing the signal.

**Stack naming.** The deploy scripts name stacks from `stackId` in `.blocks/config.json` (generated at scaffold time, e.g. `my-app-a3x9kf`): production is `<stackId>-prod`, sandbox is `<stackId>-<username>-<random>`. Use these names when inspecting stacks (e.g. `aws cloudformation describe-stacks --stack-name <stackId>-prod`). To rename, edit `stackId`; for computed names, edit `cdk-blocks/index.cdk.ts`. A stack name must not start with `aws` in any letter case: the deploy stops at synth with an error that names the fix.

## Blocks CLI

Run the npm scripts from the app root. They load the installed `aws-cdk-blocks/run` entry without downloading a CLI. Pass positional arguments directly (`npm run docs KVStore`) and put flags after `--` (`npm run dev -- --port 4000`).

- `npm run help` lists every command; `npm run help <command>` (for example `npm run help sandbox destroy`) shows one command's flags and examples.
- `--output json` prints one JSON document on stdout and keeps progress on stderr; `--query <field>` prints one field raw, for example `npm run -s deploy -- --query apiUrl` or `npm run -s whoami -- --query stacks.production`. Structured tasks, including docs, default to text in a terminal and JSON when stdout is piped or redirected. Use `npm run -s docs KVStore | jq .` to suppress npm banners. Override the format with `-- --output text` or `-- --output json`. Help and version default to text.
- `npm run destroy` asks for confirmation in a terminal. Without one (CI, an agent's shell) it refuses with exit code 2 unless you pass `--yes`: `npm run destroy -- --yes`. Ask the user before you delete their production stack.
- Exit codes: `0` success, `1` the operation failed, `2` usage error (unknown command or flag, or a confirmation the run could not give), `130` interrupted.
- Dev server settings live in `package.json` under `"blocks": { "dev": { "port", "frontendPort" } }`; `"frontend": false` there runs the backend only. `npm run dev` starts the app's Vite (or `next dev`) on `frontendPort`, behind `port`; flags such as `npm run dev -- --port 4000 --frontend-port 4100` override them. A server started with `--port` is stopped with the same flag (`npm run dev:stop -- --port 4000`), or with `npm run cleanup`, which stops every dev server the app started. Set `"frontendCommand"` only for another frontend dev server, and give it the same port as `frontendPort`; `npm run dev` warns when the command does not contain that port.
- With a `Database` block that provisions its cluster, the SQL migrations are the numbered `.sql` files in `cdk-blocks/migrations/<block id>/`. `npm run dev` applies the pending ones to the local database (PGlite, in `.bb-data/`) before the block's first query, and a deploy applies them before the new code goes live; there is no manual migration step. Run `npm run db -- status --block <id>` to see which files the local database has applied. A file the cluster cannot run stops `npm run dev` with an error that names the file and the fix.
- `npm run vendorize -- @aws-cdk-blocks/bb-kv-store` copies a Building Block's source into the app so you can customize it; `--force` overwrites an existing copy.
