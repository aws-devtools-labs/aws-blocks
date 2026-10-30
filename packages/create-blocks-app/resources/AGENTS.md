# Agent Guide

## Quick Reference

- **Backend:** `aws-blocks/index.ts` — APIs, auth, data models
- **Frontend:** `src/` — imports backend APIs via `import { api } from 'aws-blocks'`
- **Tests:** `test/e2e.test.ts` — run with `npm run test:e2e`
- **AWS Blocks docs** are in `node_modules/@aws-blocks/blocks/docs/` (the docs folder). Before you open any block doc, print the index with one command: `D=node_modules/@aws-blocks/blocks/docs; ls $D; sed -n '/BEGIN:block-catalog/,/END:block-catalog/p' $D/README.md`. It lists every docs folder (one per block, named after its package, e.g. `bb-distributed-table`) and what each block does. Then read `node_modules/@aws-blocks/blocks/docs/<folder>/README.md`, plus its `API.md` / `DESIGN.md` where present. `ApiNamespace`, `ApiError` and the typed client are in `core/README.md`; import them from `@aws-blocks/blocks`.

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

A call is always `namespace.method(...)` — e.g. `api.createTodo(title)`, `api.listTodos()`. The namespace is the **exported variable name** in `aws-blocks/index.ts` (`export const api = …` → `api`; `export const authApi = auth.createApi()` → `authApi`), not the 2nd `ApiNamespace` argument. A bare method name with no namespace will not resolve. (Auth is the same shape but pre-built: `authApi` exposes `getAuthState`/`setAuthState` — sign-up is `authApi.setAuthState({ action: 'signUp', … })`, not a bare `signUp`.)

### Auth on the frontend

An auth Building Block supplies the backend only. The frontend must let a user sign in.

- On the backend, call `await auth.requireAuth(context)` at the top of each protected method. It throws when the user is not signed in.
- On the frontend, use these parts from `@aws-blocks/blocks/ui`. Attach them the way your frontend attaches DOM elements.
  - `Authenticator(authApi)`: an element with the sign-in, sign-up and confirm forms.
  - `AuthenticatedContent(authApi, render, fallback?)`: shows `render(user)` for a signed-in user and `fallback` for a signed-out user.
  - `onAuthChange(authApi, callback)`: calls `callback(user)` when the session changes. Use it when you render the content yourself.
- `AuthBasic` without a `codeDelivery` config signs the user in at sign-up. It has no email confirmation step.

When the app is complete, a signed-out user reaches the sign-in form from the first page, the protected content appears after sign-in, and it is hidden again after sign-out.

`Authenticator` emits stable testids. For `AuthBasic` and `AuthCognito` the fields are `authenticator-username` / `authenticator-password` and the actions `authenticator-action-signIn` / `authenticator-action-signUp` / `authenticator-submit`. `CUSTOMIZING-AUTH-UI.md` is the full contract; OIDC and federated actions carry a provider suffix, e.g. `authenticator-action-signIn:google`.

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

### Live data: push with Realtime, or poll safely

For data that changes while the page is open (dashboards, counters, feeds), prefer **push over poll**: the `Realtime` block delivers updates to the browser as they happen. A backend method returns a channel handle (`await rt.getChannel(namespace, channel)`), the frontend calls `subscribe(handler)` on it, and the backend calls `rt.publish(...)` when the data changes. See the `bb-realtime` docs for the full API.

If you poll instead, every open tab calls the backend on a timer: each call is a Lambda invocation and an API Gateway request, so a careless poller wastes money and can hit the stage's rate limit. A safe poller:

1. **Never overlaps calls.** Schedule the next call after the previous one settles: chain `setTimeout`, never a fixed `setInterval`.
2. **Pauses while the tab is hidden.** Stop on `visibilitychange` → `hidden`, and refresh right away on `visible`.
3. **Makes one call per tick.** Add one backend method that returns everything the view shows, not several calls per tick.
4. **Backs off on errors**, up to a ceiling.
5. **Stops on dispose**, and ignores a response that arrives after it.

The typed client has no abort option, so a response can't be cancelled. Rules 1 and 5 make that safe: there is never more than one call in flight, and a late response is dropped.

```ts
// src/poll.ts — replace getDashboard with your own one-call-per-tick method
import { api } from 'aws-blocks';

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

## Workflow

1. Make changes to backend (`aws-blocks/index.ts`) or frontend (`src/`)
2. Test with `npm run test:e2e` — starts a dev server automatically if one isn't running
3. For faster iteration, keep one dev server running and rerun tests against it:
   - Start `npm run dev` as a background process — use your harness's background-process feature if it has one, otherwise `npm run dev &`.
   - Run `npm run test:e2e` as often as needed; it reuses the running server.
   - When finished, stop it with `npm run dev:stop` (it signals the dev server's own recorded supervisor by PID). Avoid name-matching kills like `pkill -f tsx` or `killall node`: they also match your own shell/agent process and terminate it.
4. Do NOT use curl/fetch against the API unless troubleshooting connectivity

### Calling the API directly (troubleshooting only)

If you do need to hit the API without the typed client (e.g. checking a deployed app without a browser): **every namespace is served at one endpoint**, `POST <origin>/aws-blocks/api` (locally `http://localhost:3000/aws-blocks/api`). The namespace goes in the JSON-RPC `method` field: there are no per-namespace paths like `/aws-blocks/authApi`. (The typed client also appends the namespace to the URL — `/aws-blocks/api/<namespace>` — so a gateway can route it; if you use that form, the namespace in the path must match the one in `method`, or the call fails with `-32600` Invalid Request.) The namespace is the **exported variable name** in `aws-blocks/index.ts` (`export const api = …` → `api`), not the 2nd `ApiNamespace` argument.

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
- **To store data, reach for a storage Building Block** — default to `DistributedTable` for app records you list or query as a collection (todos, notes, orders); use `KVStore` for values you read and write by one key, structured or not (settings, flags, caches, sessions, per-user preferences). Both are constructed with a `Scope` and used inside your API methods; read their `README.md`/`API.md` (see the docs pointer above) for the exact API. The full catalog (auth, files, realtime, email, scheduled/async work, …) is in the docs `README.md`.
- **The framework model above covers the common path.** Read a block's own docs (`README.md`, then `API.md` / `DESIGN.md` where present) when you need a block's specific API surface — not every block has all three, so a missing file is not an error (see the **AWS Blocks docs** bullet for where the docs folder lives).

## Deploying (requires AWS credentials)

- `npm run sandbox` — deploy backend to AWS, serve frontend locally
- `npm run sandbox:deploy` — deploy backend to AWS once and exit (no watch, no dev server); use this from scripts and CI
- `npm run deploy` — full production deploy to AWS
- `npm run sandbox:destroy` — tear down sandbox resources

`npm run deploy` does the whole deploy in one command. A first production deploy can take 10+ minutes — longer than many shell command timeouts — so run it in the background (your harness's background-process feature, or `npm run deploy > deploy.log 2>&1 &`) and let it finish. The same applies to a first `npm run sandbox:deploy`.

If `npm run sandbox` or `npm run deploy` stops with `AWS credentials could not be verified`, the message names the profile and the command that fixes it, such as `aws login --profile <name>` or `aws sso login --profile <name>`. Signing in opens a browser and needs the user: ask the user before you run the command, then re-run the npm script.

If either command stops with `CDK is not bootstrapped in Region <region> of account <account-id>`, the message includes the command that fixes it: `npx cdk bootstrap aws://<account-id>/<region> --app=`, run from the project directory. Bootstrapping is needed once per account and Region, takes a few minutes, and creates IAM roles and other resources in the user's account: ask the user before you run it, then re-run the npm script.

Before deploying, both commands print `Deployment target: <credentials>, Region <region>`, where the credentials are for example `AWS profile <name>` or `access keys in AWS_ACCESS_KEY_ID`, then the account name and plan. When the credentials are the AWS-managed role of the new AWS sign-up experience, a link to `https://settings.aws.com/billing` follows; other accounts get no link. The deploy does not pause: if the credentials or Region are not the ones the user expects, stop the command (Ctrl-C) and ask. `Account name: not available` or `Account plan: not available` is not an error: the deploy continues. Never change a spend limit yourself. When the output has the billing link, give it to the user, and ask them to verify in AWS Settings that the project they manage matches the CLI deployment target. If the user signs in with `aws login`, the profile Region must be set to the project's Region before sign-in (`aws configure set region <region> --profile <name>`); after changing it, they run `aws login` again.

On success `npm run deploy` prints one machine-readable line last — `BLOCKS_DEPLOYED url=<frontend> api=<backend>` (a backend-only app omits `url=`). Wait for that line — it confirms the deploy finished and gives the URLs, so there's no need to poll CloudFormation or hunt the URL out of the streamed output.

`npm run sandbox:deploy` prints `BLOCKS_DEPLOYED api=<backend>` too. The typed client (`aws-blocks/client.js`) is generated before the deploy and `.blocks-sandbox/config.json` is written before the line, so once you see it the app is ready to run against the sandbox. To get the API URL alone in a script, run `npx --no -- blocks sandbox deploy --query apiUrl`.

If you will immediately self-test the frontend, add `npm run deploy -- --wait-live`: it holds the `BLOCKS_DEPLOYED` line until the new build is actually being served through CloudFront, so a request issued right after the signal returns the new asset rather than a stale cached bundle. Without it, the signal fires as soon as the deploy process exits, which can be a few seconds before the edge finishes serving the new build. Tune the budget with `--wait-live-timeout=<seconds>` (default 180); if it can't confirm within the budget it says so and exits non-zero instead of printing the signal.

**Stack naming.** The deploy scripts name stacks from `stackId` in `.blocks/config.json` (generated at scaffold time, e.g. `my-app-a3x9kf`): production is `<stackId>-prod`, sandbox is `<stackId>-<username>-<random>`. Use these names when inspecting stacks (e.g. `aws cloudformation describe-stacks --stack-name <stackId>-prod`). To rename, edit `stackId`; for computed names, edit `aws-blocks/index.cdk.ts`.

## Blocks CLI

Every `npm run …` script above is a thin alias of the `blocks` command from `@aws-blocks/blocks` (for example `"deploy": "blocks deploy"`), so prefer the npm scripts: `npm run deploy` runs `blocks deploy`, and `npm run dev -- --port 4000` passes flags through. When you need the command directly, run `npx --no -- blocks <command>`. Always keep `--no`: it uses the app's installed CLI and never downloads a package, and `blocks` on the npm registry is an unrelated package.

- `npx --no -- blocks --help` lists every command; `npx --no -- blocks help <command>` (for example `npx --no -- blocks help sandbox destroy`) shows one command's flags and examples.
- `--output json` prints one JSON document on stdout and keeps progress on stderr; `--query <field>` prints one field raw, for example `npx --no -- blocks deploy --query apiUrl` or `npx --no -- blocks whoami --query stacks.production`.
- `npm run destroy` asks for confirmation in a terminal. Without one (CI, an agent's shell) it refuses with exit code 2 unless you pass `--yes`: `npm run destroy -- --yes`. Ask the user before you delete their production stack.
- Exit codes: `0` success, `1` the operation failed, `2` usage error (unknown command or flag, or a confirmation the run could not give), `130` interrupted.
- Dev server settings live in `package.json` under `"blocks": { "dev": { "port", "frontendCommand", "frontendPort" } }`; flags such as `npm run dev -- --port 4000` override them.
