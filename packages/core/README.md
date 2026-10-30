# @aws-blocks/core

Core primitives for building full-stack applications with the AWS Blocks.

## Key Exports

### Scope

Defines the boundary for your backend resources. The `Scope` class docstring serves as an index to all available Building Blocks.

```typescript
import { Scope } from '@aws-blocks/core';

const scope = new Scope('my-app');
```

### ApiNamespace

Define type-safe APIs with automatic frontend/backend integration.

```typescript
import { ApiNamespace } from '@aws-blocks/core';

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!` };
  }
}));
```

Frontend usage (fully typed):

```typescript
import { api } from 'aws-blocks';

const result = await api.greet('World');
```

#### Authentication — every method is a public endpoint

Each method you define becomes a public, internet-reachable RPC endpoint. There is **no authentication by default** — a method is callable by anyone until you gate it. Auth is opt-in, per method, by calling the `Auth` Building Block at the top of the handler:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  // PUBLIC — intentionally callable by anyone.
  async listPublicPosts() {
    return db.posts.findPublished();
  },

  // GATED — requireAuth throws a 401 before the body runs.
  async createPost(input: NewPost) {
    const user = await auth.requireAuth(context);
    return db.posts.create({ ...input, authorId: user.userId });
  },
}));
```

The local mock applies no auth either, so an ungated method passes every local check and still ships callable by anyone. See the `Auth` README (`@aws-blocks/bb-auth`) for `requireAuth` / `requireRole`.

Only the methods your handler's object defines are callable — its own properties (including any spread in from another object), or methods its class defines. Members every object inherits (`constructor`, `toString`, `hasOwnProperty`, `__proto__`, …), properties hidden with `Object.defineProperty`, and the methods of a Building Block (exported, e.g. `export const notes = new KVStore(...)`, or returned by a handler) are never endpoints; calling one returns the same "Method not found" error as an unknown name.

#### What the RPC endpoint can reach

The RPC endpoint dispatches `<exportName>.<method>` against your backend module's exports. Export **`ApiNamespace` values** for anything the client should call — and keep Building Block instances unexported (or reach them only through a gated method):

- An exported **Building Block instance** (e.g. `export const todos = new DistributedTable(scope, 'todos')`) is **not** callable over RPC — calling `todos.put` returns *method not found*. Its data plane is only reachable through the `ApiNamespace` methods you write, where your `requireAuth` gates run.
- **`_`-prefixed exports** are private: they get no client proxy and are not dispatched.
- **`secret()` / `config()` markers** are deferred values, not APIs: they get no client proxy and are not dispatched.
- Only **callable methods** are dispatched; members inherited from `Object.prototype` (`toString`, `constructor`, `hasOwnProperty`, …) are never reachable.

#### Calling the API over HTTP (JSON-RPC 2.0)

The typed `import { api } from 'aws-blocks'` client is the normal path. The HTTP form below is for manual verification (curl/Postman) and non-JS clients.

`POST` to the RPC path `/aws-blocks/api`:

- Local dev: `http://localhost:3000/aws-blocks/api` (the default template serves the backend and frontend from a single front door on `:3000`). Only the `backend` and `amplify` templates serve the API on `:3001`.
- Deployed: the API Gateway stage URL + `/aws-blocks/api`

The body is JSON-RPC 2.0:

```json
{ "jsonrpc": "2.0", "method": "<namespace>.<methodName>", "params": [...], "id": 1 }
```

- `method` is `<namespace>.<methodName>`, where `<namespace>` is the **export variable name** from `aws-blocks/index.ts` (e.g., `export const api = ...` → `api`).
- `params` is a POSITIONAL array of the method's arguments. A named object also works (its values are used in order).
- Errors come back as HTTP `200` with an `error` object in the body (per JSON-RPC), not as a non-2xx status.

Error responses use these JSON-RPC codes:

| Code | Meaning | When Blocks uses it |
|------|---------|---------------------|
| `-32700` | Parse error | Request body is not valid JSON. |
| `-32600` | Invalid Request | Body is not a valid Blocks JSON-RPC request, such as missing `jsonrpc: "2.0"` or a `method` that is not `namespace.method`. |
| `-32601` | Method not found | The requested namespace is not exported by the backend, or the method is not one the API defines (inherited members such as `toString` don't count). |
| `-32602` | Invalid params | Reserved for JSON-RPC parameter validation failures. Application-level validation should throw an `ApiError` with the appropriate HTTP status instead. |
| `-32603` | Internal error | Reserved for generic JSON-RPC internal errors. Unhandled application errors currently use code `500`. |

Errors thrown with `ApiError` use the positive HTTP status as the JSON-RPC `error.code` (for example, `401`, `404`, or `409`) and include `error.data.name` when an error name is available. The typed client converts JSON-RPC errors back into `ApiError`.

Working example:

```bash
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.greet","params":["World"],"id":1}'
# → {"jsonrpc":"2.0","result":{"message":"Hello, World!"},"id":1}
```

#### Closed connections and the single resend (Node clients)

Node's `fetch` keeps idle connections open for reuse. A deployed API (API Gateway, a load balancer) can close an idle connection at any moment without warning, and if that close crosses your next call, Node's `fetch` fails it with `TypeError: fetch failed` (cause `SocketError: other side closed`, `ECONNRESET` or `EPIPE`) and does not resend it, even for a `GET`. This shows up in CLIs, SSR servers and scripts after a few idle seconds.

The typed client handles it: when `fetch` fails with `TypeError: fetch failed` whose cause is an undici socket error (`UND_ERR_SOCKET`, for example `other side closed`), `ECONNRESET` or `EPIPE`, **before the response headers arrived**, it resends the identical request **once** on a new connection. A partial status line followed by a close counts too, since the headers never arrived. In the idle-close race the first copy never reached the server. Node's `fetch` doesn't say whether the failed connection was a reused one, so the client matches on the error alone: the same failure on a fresh connection, such as a server that read the request and crashed before answering, is resent too, and in that rare case a method runs twice. Delivery is therefore **at-least-once**. The server can't tell a resend from a new call. Behind API Gateway or CloudFront a crashed backend answers with a `5xx` instead, which is never retried. Keep state-changing methods idempotent where a duplicate would matter. Nothing else is retried: not a second connection failure, not a timeout or abort, not a failure after the response headers arrived (while reading the body), not an HTTP or JSON-RPC error. Browsers already do this resend themselves, so frontend behaviour is unchanged.

To turn the resend off (at-most-once delivery; the failure reaches your code instead), pass `retryStaleConnection: false`:

```ts
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';

const api = ApiNamespaceClient<typeof import('./aws-blocks/index.js').api>('api', {
  retryStaleConnection: false,
});
```

The generated client's `generateClient` takes the same options: `generateClient({ url, retryStaleConnection: false })`.

Your own `fetch` calls (to a `RawRoute`, or the JSON-RPC endpoint called by hand) don't get this. In Node, resend a request yourself when it fails with one of those causes and is safe to repeat.

#### How the server reads `params` (and what it rejects)

The request body is parsed by `parseRpcRequest`, which turns `params` into the positional argument list your method is called with:

| Body `params` | Arguments the method receives |
|---|---|
| `["World", 42]` (array) | `('World', 42)`, used as-is |
| `{"name":"World","times":42}` (object) | `('World', 42)` via `Object.values()`, so **key insertion order decides argument order** |
| omitted or `null` | `()`, no arguments |

A named object is convenient for `curl`, but it is only safe when the keys are written in the same order as the method signature. Prefer the array form in anything automated.

One shape that looks reasonable and is **not** supported: a top-level JSON **array** as the whole body (a JSON-RPC batch). The parser reads `jsonrpc` and `method` off the body object, so an array body fails validation instead of running anything:

```bash
curl -X POST http://localhost:3000/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '[{"jsonrpc":"2.0","method":"api.greet","params":["a"],"id":1}]'
# → HTTP 200
# {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: expected JSON-RPC 2.0 — ...",
#    "data":{"name":"InvalidRequest"}},"id":null}
```

`id` is `null` in that response because an array body has no `id` to echo. Send one call per request. Body that isn't valid JSON at all returns `-32700 Parse error`, also with HTTP `200`.

#### Runtime config (`/.blocks-sandbox/config.json`)

The generated client does not hardcode the API URL; it resolves one at first call, in this order:

1. `BLOCKS_API_URL` env var (set by the Hosting construct on SSR compute).
2. `BLOCKS_CONFIG` env var (the whole config as JSON).
3. Node only: the file `.blocks-sandbox/config.json`, read from the **process working directory**.
4. Browser only: `fetch('/.blocks-sandbox/config.json')`.

Both env vars are normally written for you: `Hosting` injects them into every SSR compute function at synth, and `npm run sandbox` sets `BLOCKS_API_URL` on the dev server it spawns. You set `BLOCKS_API_URL` yourself only when you run the SSR host outside that tooling, like a framework dev server on its own port (`BLOCKS_API_URL=http://localhost:3001/aws-blocks/api next dev`) or your own container. `BLOCKS_CONFIG` is Hosting's serialized `backendConfig` rather than a knob to hand-write, so prefer `BLOCKS_API_URL` for a custom host.

Two things about that path burn time when debugging:

- The directory is **dotted**: `/.blocks-sandbox/config.json`. `/config.json` is not a route and never was: locally the dev server only answers `GET /.blocks-sandbox/config.json`, and in production the Hosting construct only adds a `/.blocks-sandbox/*` static behaviour. A `404` from `curl http://localhost:3000/config.json` says nothing about your config.
- `{"_placeholder":true}` is a **valid, expected** body in the frontend build output. The Hosting construct writes that stub into the static assets directory during CDK synth so the file exists as a static route while the real `apiUrl` is still an unresolved CloudFormation token; the deploy then uploads the resolved config over it. Finding the stub in `dist/.blocks-sandbox/config.json` (or on the origin between synth and deploy) is the design working, not a broken config.

What you should see instead, per environment:

```bash
# Local dev / sandbox: served by the dev server itself, Cache-Control: no-store
curl http://localhost:3000/.blocks-sandbox/config.json
# → {"apiUrl":"http://localhost:3000/aws-blocks/api","environment":"local"}

# After a deploy: written by the deploy script and uploaded to the origin
cat .blocks-sandbox/config.json
# → { "apiUrl": "https://<id>.execute-api.<region>.amazonaws.com/prod/aws-blocks/api", "environment": "production" }
#   (under apiFrontDoor:'cloudfront' this is the CloudFront domain + /aws-blocks/api instead)
```

So a real config problem looks like the client throwing `Blocks API URL not configured` (or `... is not configured (source: ...)`), not like a `404` on `/config.json`. If a **deployed** origin keeps serving `{"_placeholder":true}` after a successful deploy, that is a genuine bug: the config upload or the CloudFront invalidation did not land.

### Shared API gateway

A deployed `BlocksStack` / `BlocksBackend` puts **one shared API Gateway REST API** in front of the whole backend (see [API front door](#api-front-door) for how it is exposed). It is the stack's `gateway`, and its RPC URL is the `ApiUrl` stack output.

- **Every path reaches your backend.** Catch-all proxy resources forward every method and path to the backend Lambda, which dispatches JSON-RPC and your `RawRoute`s, so adding a `RawRoute` creates no AWS resources. Each namespace also has its own path (`/aws-blocks/api/{namespace}`), so a namespace given its own compute (`new ApiNamespace(scope, name, handler, { compute })`, see `@aws-blocks/bb-compute`) is routed there without changing the app's endpoint.
- **Throttling** is on by default from `defaults.throttling` (sandbox 200 requests/s with a 400 burst, production 1000/2000). **Structured JSON access logs** are opt-in via `defaults.accessLogging`; each entry records the matched route (`resourcePath`) — the route template, so requests served by the catch-all resources (every namespace on the default compute, every `RawRoute`) log as their `{proxy+}` resource rather than the path called.
- **Limits:** the gateway times out a request after 29 seconds and caps payloads at 10 MB. Run longer work in an `AsyncJob`.
- **WAF** is off by default. Turn it on with `apiWaf` on `BlocksStack` / `BlocksBackend`: `apiWaf: { enabled: true, rateLimit? }` creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit (default 1000 requests per 5 minutes). The Common rule set's body rules (`SizeRestrictions_BODY`, `CrossSiteScripting_BODY`, `GenericLFI_BODY`, `GenericRFI_BODY`) only count, so normal RPC payloads, including user-written HTML or Markdown, pass. `apiWaf: { webAclArn }` attaches a web ACL you already have instead; its scope and region are checked at synth. It's attached as-is, so behind a `Hosting` door its IP rate rules count CloudFront edge or proxy IPs for browser traffic. The web ACL goes on whichever front door clients use:
  - `apiFrontDoor: 'apigateway'` — a `REGIONAL` web ACL on the gateway stage, in any region. If a `Hosting` door also forwards browser traffic to it, the rate rule adjusts so browser users aren't counted as one client: a CloudFront `Hosting` that claims the API sends a marker header the rate rule exempts, and behind any other door (ALB, API Gateway, your own, or a CloudFront edge over a router) the rate rule is left off and synth warns (`blocks:api-waf:no-rate-limit-behind-door`), so rate-limit on the door's own WAF. In both cases browser requests arriving through Hosting aren't rate-limited by `apiWaf`; turn on the door's own WAF (`frontDoor: { features: { waf: { enabled: true } } }`) to rate-limit them.
  - `apiFrontDoor: 'cloudfront'` — a `CLOUDFRONT` web ACL on the managed distribution. AWS only creates these in us-east-1, so in other regions pass `webAclArn` of one created there (`enabled: true` fails synth).
  - `apiFrontDoor: 'cloudfront'` with a CloudFront-backed `Hosting` fronting the API: the API is served from Hosting's distribution, so set the WAF on Hosting (`frontDoor: { features: { waf: { enabled: true } } }`); `apiWaf` then creates nothing and synth warns (`blocks:api-waf:deferred-to-hosting`).
  - Not covered: the gateway's `execute-api` endpoint under `'cloudfront'` (callable directly, and reached by browser traffic that a non-CloudFront `Hosting` door forwards), and `bb-realtime`'s WebSocket API (AWS WAF can't attach to API Gateway WebSocket APIs).

### API front door

How the backend's API is exposed to clients is chosen with the `apiFrontDoor` prop on `BlocksStack` / `BlocksBackend` (default `'apigateway'`):

- **`'apigateway'`** (default) — clients call the stack's API Gateway endpoint directly, on its own `execute-api` domain. Nothing extra to deploy.
- **`'cloudfront'`** — Blocks puts a CloudFront distribution in front of that gateway (and builds the gateway as a regional endpoint, so there is a single CloudFront layer); clients call the distribution's domain instead.

Under either tier, the URL clients should call is `publicApiUrl` on the stack or backend — for a `BlocksStack` that is also the `ApiUrl` stack output. With `'cloudfront'` it is the distribution's URL + `/aws-blocks/api`; otherwise it equals `apiUrl`, the gateway's own URL.

The default is a constant — it is never derived from the app's shape, so adding or removing Building Blocks never silently changes how the API is exposed.

Either tier serves the API at the same path. The TypeScript client (and any manual caller that addresses a namespace) POSTs JSON-RPC to a per-namespace path:

```
POST /aws-blocks/api/{namespace}
```

where `{namespace}` is the backend export name (`export const api = …` → `api`). The bare `POST /aws-blocks/api` form still works for back-compat. Either way the request body's `method` (`"api.greet"`) names the namespace that runs; a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the call fails with a JSON-RPC `-32600` Invalid Request. Internally the shared gateway routes each namespace's path to the compute that hosts it; by default every namespace runs on the single default compute, so every path lands on the same function. Pass `{ compute }` as the fourth `ApiNamespace` argument to run a namespace on its own `Compute`; the API namespaces section of the `@aws-blocks/bb-compute` README lists what that changes (and what it doesn't), including which callers reach the namespace's compute.

**Hosting is same-origin.** When you pass the backend to the `Hosting` construct, the frontend and the API are served from one origin, so the browser treats `/aws-blocks/api/*` calls as same-origin and no CORS configuration is needed (see the CORS Configuration section below). With `'cloudfront'`, a CloudFront-backed `Hosting` door (the CloudFront default, or the `stacked` door's edge) takes the front-door role and no second distribution is created. Behind the `alb`, `apiGateway` and `custom` doors the browser still reaches the API same-origin, but the API keeps its own distribution and `ApiUrl` stays on it for every other client; `'none'` serves static files only, so the browser calls the API cross-origin.

Neither tier makes CloudFront the only way in: the gateway's own `execute-api` URL stays publicly reachable, so a WebACL on a CloudFront distribution doesn't cover direct calls to it.

> ⚠️ **Switching tiers — or adding or removing `Hosting` under `'cloudfront'` — changes the API's endpoint domain.** Browser auth cookies and sessions are bound to the origin that set them, so the change invalidates every existing cookie/session — users are signed out and must sign in again. Pick a tier, and decide on Hosting, before you have real users, and treat a later change as a breaking migration.

### ApiError / isBlocksError / hasAuthError

Typed error handling across the wire. All three are exported from `@aws-blocks/core`, and re-exported from `@aws-blocks/blocks`.

```typescript
import { ApiError, isBlocksError } from '@aws-blocks/core';

// Throw with HTTP status and error name
throw new ApiError('Not found', 404, { name: 'ItemNotFoundException' });

// Catch with type narrowing
catch (e) {
  if (isBlocksError(e, 'ItemNotFoundException')) { ... }
}
```

#### `new ApiError(message, status, options?)`

```typescript
new ApiError(
  message: string,
  status: number,
  options?: { name?: string; cause?: unknown; retriable?: boolean },
)
```

| Argument | Required | What it does |
|---|---|---|
| `message` | yes | Human-facing text. Crosses the wire, so don't put internals in it. |
| `status` | yes | HTTP status code. Any number; nothing validates it against a known status. |
| `options.name` | no | The structured error name `isBlocksError` / `hasAuthError` match on (e.g. `'ItemNotFoundException'`). Defaults to `'ApiError'`, which carries no meaning, so treat it as "unnamed". |
| `options.cause` | no | Underlying error. **Stays server-side**, never serialized. |
| `options.retriable` | no | `true` when the caller can retry the same action without restarting the flow (wrong MFA code, wrong password on re-prompt). Defaults to `false`. |

The instance exposes `message`, `name`, `status` and `retriable` as readable properties, and it is a real `Error`, so `instanceof Error` and stack traces behave normally.

How `status` reaches the client over JSON-RPC: an uncaught error inside an RPC method is encoded as an error response whose **`code` is the `ApiError`'s `status`** (positive numbers can't collide with the reserved `-32xxx` range). `name` and `retriable` ride along in `error.data`. A non-`ApiError` throw becomes code `500` with no `data.name`.

```jsonc
// throw new ApiError('Username already taken', 409,
//   { name: 'ConditionalCheckFailedException', retriable: true })
{ "jsonrpc": "2.0", "id": 1, "error": {
  "code": 409,
  "message": "Username already taken",
  "data": { "name": "ConditionalCheckFailedException", "retriable": true }
}}
```

The client decodes that back into an `ApiError` with the same `status`, `name` and `retriable`, which is why the same `isBlocksError(e, ...)` check works on both sides. Reserved JSON-RPC codes (`-32600`, `-32700`, …) decode to `status: 500`.

#### `hasAuthError(state, name)`

```typescript
import { hasAuthError } from '@aws-blocks/core';

function hasAuthError<T extends { errorName?: string }, N extends string>(
  state: T | null | undefined,
  name: N,
): state is T & { errorName: N }
```

`Auth`'s recommended client path (`setAuthState()` / `getAuthState()`) **returns** a failed `AuthState` instead of throwing, so there is no `Error` for `isBlocksError` to inspect. `hasAuthError` is the equivalent guard for that returned object: it compares `state.errorName` to `name` and narrows the type. It's a plain equality check, so a `null` / `undefined` state and a state with no `errorName` both return `false` and no defensive wrapping is needed.

```typescript
const next = await authApi.setAuthState({ action: 'signIn', username, password });
if (hasAuthError(next, AuthErrors.NotAuthorized)) {
  // unknown user or wrong password → offer sign-up
}
```

Rule of thumb: **thrown error → `isBlocksError`; returned `AuthState` → `hasAuthError`.** Match on the block's error constant, never on the human-facing `error` string.

### RawRoute

Path-based HTTP routing Building Block for endpoints that need full request/response control: webhooks, health checks, redirects, file downloads, anything a browser or third party has to hit with a plain `GET`. Use `ApiNamespace` (RPC) for typed function calls; use `RawRoute` when you need raw HTTP semantics.

```typescript
new RawRoute(scope: ScopeParent, id: string, options: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  path?: string;
  handler: (context: BlocksContext) => Promise<void>;
})
```

A full `GET` that sets its own status, content type and body:

```typescript
import { RawRoute } from '@aws-blocks/blocks';

new RawRoute(scope, 'status', {
  method: 'GET',
  path: '/status',
  handler: async (ctx) => {
    ctx.response.status = 200;
    ctx.response.headers.set('Content-Type', 'text/html; charset=utf-8');
    ctx.response.send('<h1>ok</h1>');
  },
});
```

```bash
curl -i http://localhost:3000/status
# HTTP/1.1 200 OK
# content-type: text/html; charset=utf-8
#
# <h1>ok</h1>
```

The handler returns nothing; you write the response through `ctx.response`:

| On `ctx.response` | Notes |
|---|---|
| `status: number` | Assignable. Defaults to `200`. |
| `headers: Headers` | Standard `Headers`. Set `Content-Type` yourself; a string body is sent as-is, an object is serialized as JSON. |
| `send(body)` | Call once with the body. `send('')` for an empty body (redirects, `204`). |

And what you read from `ctx.request`:

| On `ctx.request` | Notes |
|---|---|
| `params` | Path parameters, e.g. route `/users/{id}` + request `/users/42` → `{ id: '42' }`. Always `{}` for RPC methods. |
| `url` | Absolute `URL` of the request. Use `url.searchParams` for the query string. |
| `headers` | Request `Headers`, including `cookie`. |
| `json()` / `text()` / `body` | Body as parsed JSON, raw text, or a `ReadableStream`. |
| `signal` | `AbortSignal` that fires just before the platform's timeout response. Pass it to `fetch`/SDK calls. `undefined` in local dev. |

Reading a path parameter and a query parameter:

```typescript
new RawRoute(scope, 'user', {
  method: 'GET',
  path: '/users/{id}',
  handler: async (ctx) => {
    ctx.response.headers.set('Content-Type', 'application/json');
    ctx.response.send({ id: ctx.request.params.id, q: ctx.request.url.searchParams.get('q') });
  },
});
// GET /users/42?q=hello → {"id":"42","q":"hello"}
```

Path syntax: exact (`/health`), named parameter capturing one segment (`/users/{id}`), or a trailing wildcard capturing the rest (`/files/*`, available as `params['*']`). One wildcard per route, last segment only. Named parameters are URL-decoded; wildcard captures are not, so validate them before touching a filesystem or an S3 key.

`path` can be omitted, in which case it is derived from the scope-chain IDs, so `Scope('app') → Scope('v1') → RawRoute('health')` gives `/v1/health`. That means restructuring your construct tree silently changes URLs, so pass an explicit `path` for anything a client depends on.

Registration rules worth knowing before you hit them at runtime:

- Routes must be constructed while the backend module is loading (top level of `aws-blocks/index.ts`, or from a block's constructor). Registering after the handler is created throws.
- `/aws-blocks` itself and `/aws-blocks/api` (plus anything under it) are reserved for RPC dispatch, and `/` is not routable, so use a sub-path.
- The same `method` + `path` twice throws `RawRouteErrors.DuplicateRoute`; catch it with `isBlocksError(e, RawRouteErrors.DuplicateRoute)`.
- No extra AWS resources are created. The existing API Gateway proxy already forwards every path to the same Lambda, which checks the route registry before falling through to RPC.

### Pipeline

CDK Pipelines-based CI/CD construct for multi-branch, multi-stage deployments. Creates self-mutating CodePipeline V2 instances with GitHub source via CodeConnections (OAuth).

📖 **Full Pipeline documentation (see source repo)**

### Hosting

CDK construct (from the `/cdk` entry point) that deploys a frontend on S3 behind a front door — CloudFront by default, or another door (`frontDoor`, below) — with a single-origin API proxy when a backend stack is provided.

```typescript
import { Hosting } from '@aws-blocks/core/cdk';

new Hosting(stack, 'Web', {
  root: join(__dirname, '..'),
  buildCommand: 'npm run build',
  api: blocksStack,
});
```

The `framework` option selects the frontend type: `'spa' | 'static' | 'nextjs'`. When omitted, the framework is auto-detected by reading your app's OWN `package.json` (not `node_modules`): a `next` dependency → `nextjs`; otherwise `spa`; and `static` when there is no `package.json`. Set `framework: 'spa'` explicitly to override auto-detection — e.g. when a stray `next` dependency would otherwise trigger an unwanted Next.js/OpenNext build. Full reference lives in the source JSDoc.

Old builds are retained for rollback and expired by an S3 lifecycle rule after `buildRetentionDays` (default **30**). The build currently being served is never expired regardless of deploy cadence — only superseded builds are cleaned up. Only builds superseded by a normal `Update` cutover are auto-tagged (and thus auto-expired): pre-existing/orphaned builds and aborted or rolled-back deploys are never tagged and need manual cleanup (e.g. an S3 inventory / Batch Operations sweep). Raise the window with `buildRetentionDays` (it must be ≥ `skewProtection.maxAge` in days):

```typescript
new Hosting(stack, 'Web', {
  root: join(__dirname, '..'),
  api: blocksStack,
  buildRetentionDays: 90,
});
```

Core's top-level `buildRetentionDays` maps to the L3 construct's `storage.buildRetentionDays`.

#### Front door and its settings

`frontDoor` picks the public entry point: omit it for CloudFront (the default), or pass `{ kind: 'alb' }`, `{ kind: 'apiGateway', api?: 'http' | 'rest' }`, `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }`, `{ kind: 'custom', door }` or `'none'` (a public S3 website bucket). The settings the app asks the door for go in `frontDoor.features`, typed per kind, so a setting the chosen door doesn't implement does not compile. `{ features }` with no `kind` is the CloudFront default with settings:

```typescript
import { PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import { Hosting } from '@aws-blocks/core/cdk';

new Hosting(stack, 'Web', {
  root: join(__dirname, '..'),
  api: blocksStack,
  frontDoor: {
    features: {
      domain: { domainName: 'app.example.com', hostedZone: 'example.com' },
      waf: { enabled: true },
      priceClass: PriceClass.PRICE_CLASS_ALL,
    },
  },
});
```

A `config()` domain works in `frontDoor.features.domain` too, through the async `Hosting.create()`, as for the top-level `domain`.

| Setting | CloudFront | ALB | API Gateway | Stacked | Custom |
|---|---|---|---|---|---|
| `domain` | ✓ | ✓ (with `certificate`; no `wwwRedirect`) | ✓ (no `wwwRedirect`) | `router.domain` (the name the edge reaches the router at over HTTPS, with `certificate`) | ✓ |
| `waf` | ✓ | ✓ (REGIONAL) | – | `edge.waf.webAclArn` (CLOUDFRONT), `router.waf` (REGIONAL) | ✓ |
| `logging` | ✓ | ✓ (off unless set) | – | `router.logging` | ✓ |
| `monitoring` | ✓ | ✓ (`enabled` only, on unless `enabled: false`) | – | `router.monitoring` (`enabled` only) | ✓ |
| `skewProtection` | ✓ | – | – | – | ✓ |
| `geoRestriction` | ✓ | – | – | – | ✓ |
| `contentSecurityPolicy` | ✓ | – | – | `edge.contentSecurityPolicy` | – |
| `priceClass`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas` | ✓ | – | – | – | – |

The stacked door's edge → router hop is HTTPS on port 443 with a router `certificate` and `features.router.domain`; without them it is plain HTTP (unencrypted; on the AWS network with `internal: true`, else to the ALB's public addresses, which synth warns about). The router admits only the edge through a header whose value Secrets Manager generates once per stack.

Switching `frontDoor` on a deployed app replaces the front door: the URL changes (sessions scoped to the old host end), and a custom domain moving from one door to another collides in Route 53 while both exist — remove it from the old door first. See the `@aws-blocks/hosting` README.

The top-level `domain`, `waf`, `logging`, `monitoring`, `skewProtection`, `contentSecurityPolicy`, `priceClass`, `geoRestriction`, `quotas`, `ssrDefaultTtl`, `cacheKeyCookies` and `cacheKeyHeaders` props are deprecated aliases: they keep working, merged into `frontDoor.features` at construction, and an app that sets them with no `frontDoor` synthesizes the same template as before. To migrate, move each one into `frontDoor.features` under the same name. Setting one both ways fails synth (`FrontDoorSettingConflictError`), and so does a top-level prop the chosen kind doesn't implement (`UnsupportedFrontDoorSettingError`; the stacked door takes its settings per layer only). See the `@aws-blocks/hosting` README for each door and for writing your own.


## Building Blocks

Import Building Blocks from their specific packages (or from the `@aws-blocks/blocks` umbrella):

- `@aws-blocks/bb-kv-store` — Key-value storage
- `@aws-blocks/bb-distributed-table` — Tables with Zod schemas and indexes
- `@aws-blocks/auth-common` — Auth interfaces and Authenticator component
- `@aws-blocks/bb-auth` — Authentication (email + password, social, OIDC and SAML)
- `@aws-blocks/bb-data` — SQL database
- `@aws-blocks/bb-realtime` — Real-time pub/sub

### withAuth (SSR cookie forwarding)

Lives in the `@aws-blocks/core/server` entry point (also re-exported as `@aws-blocks/blocks/server`). During SSR (server components / loaders) the browser's cookies aren't automatically attached to AWS Blocks API calls — `withAuth` reads them and forwards them to every AWS Blocks API call made inside the callback.

```typescript
import { withAuth } from '@aws-blocks/blocks/server';

// Auto-detects cookies (Next.js detection is built in)
const posts = await withAuth(() => api.listMyPosts());

// Other frameworks: pass cookies explicitly as the 2nd arg…
const posts = await withAuth(() => api.listMyPosts(), request.headers.get('cookie'));
// …or register a provider once via registerCookieProvider.
```

**Note:** `withAuth` throws a `401` `ApiError` when no cookies are found. Full reference lives in the source JSDoc.

## Local Development

In local dev mode, Building Blocks use mock implementations. No AWS resources needed.

The dev server (`npm run dev`) listens on **`127.0.0.1` (loopback) only**, so nothing on your network can reach it. It serves your whole API against the local mock data, and local auth authenticates nothing. In a container or a remote devbox where you control who can reach the port, opt into a wider interface:

```bash
BLOCKS_DEV_HOST=0.0.0.0 npm run dev   # prints a warning: anyone who can reach this interface can call your API
```

You can also pass `host` to `startDevServer({ host })` in `aws-blocks/scripts/server.ts`. The local realtime WebSocket (`/realtime`) accepts upgrades only from loopback origins, or from the host you opted into:

- With a **wildcard** (`BLOCKS_DEV_HOST=0.0.0.0`), open the app **by IP address** (e.g. `http://192.168.1.10:3000`). Same-origin pages reached by IP are accepted; DNS names are not, because a same-origin check against a name can be defeated by DNS rebinding.
- To open it by **hostname** (e.g. `http://mybox.example.com:3000`), set `BLOCKS_DEV_HOST=mybox.example.com` instead.

Only server-side `Realtime.publish()` can publish. Clients can subscribe, but not publish, exactly as in a deployed app.

## CORS Configuration

By default, the Lambda handler does **not** set any `Access-Control-Allow-Origin` header. Allowed origins come from two places: the stack's `defaults.allowedOrigins` (regex patterns; every Blocks compute receives them as the `CORS_ALLOWED_ORIGINS` environment variable) and, when you use `Hosting`, the distribution's own domain (registered automatically as `CORS_HOSTING_ORIGINS`).

### When using Hosting (recommended)

If you use the `Hosting` construct with your API, CORS is handled automatically:

- **Same-origin requests** (frontend fetches through the front door's proxy at `/aws-blocks/api`) work without CORS headers since the browser treats them as same-origin.
- **Cross-origin requests** (e.g. direct API Gateway calls) are also covered: when you pass a `BlocksStack` or `BlocksBackend` as the `api` prop, the Hosting construct registers the front door's URL (the CloudFront distribution's domain, your custom domain, or another door's address) as `CORS_HOSTING_ORIGINS` in the backend's S3 config, where it is compiled separately as an escaped literal origin. Your `CORS_ALLOWED_ORIGINS` is left untouched. You do **not** need to configure CORS manually.

With the sandbox preset, the localhost pattern from `defaults.allowedOrigins` is also kept, so your local dev frontend still works.

### Local development (`npm run dev`)

The dev server automatically allows `localhost` / `127.0.0.1` origins. No configuration needed.

### Sandbox deployments

`BlocksPresets.sandbox` sets `allowedOrigins` to `['^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$']`, so your local frontend can reach the deployed sandbox API. To allow more origins in sandbox, append to the preset's list rather than replacing it:

```typescript
defaults: {
  ...BlocksPresets.sandbox,
  allowedOrigins: [...BlocksPresets.sandbox.allowedOrigins, 'https://preview\\.myapp\\.com'],
},
```

### Production (frontend hosted separately)

If your frontend is hosted on a different domain (e.g., Vercel, Netlify), list its origins in the stack's `defaults.allowedOrigins` — every Blocks compute gets them as `CORS_ALLOWED_ORIGINS`:

```typescript
// aws-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...BlocksPresets.production,
    allowedOrigins: ['https://myapp\\.com', 'https://staging\\.myapp\\.com'],
  },
});
```

Each entry is treated as a **regex pattern** (anchored with `^` and `$`). Examples:

| Pattern | Matches |
|---------|---------|
| `https://myapp\\.com` | Exact match for `https://myapp.com` |
| `https://.*\\.myapp\\.com` | Any subdomain of `myapp.com` |
| `^https?://(localhost\|127\\.0\\.0\\.1)(:\\d+)?$` | Localhost/127.0.0.1, any port, http or https (sandbox) |
| `.*` | All origins (escape hatch — use with caution) |

Multiple patterns are comma-separated. If a pattern is invalid regex, it falls back to literal string match.

> **Escape the dots.** Because each entry is a regex, an unescaped `.` matches *any* character — so `https://app.example.com` also matches unrelated hosts like `https://appXexample.com`. Always escape literal dots: write `https://app\\.example\\.com`, not `https://app.example.com`. Each entry is compiled as `^(?:<entry>)$`, so it must match the whole origin: `^https://app\\.example\\.com` (or just `https://app\\.example\\.com`) matches that exact origin, not `https://app.example.com.extra`. Because the anchors wrap the whole expression, every branch of a top-level `|` alternation is anchored too. Prefer separate comma-separated entries over one `|`-joined entry for readability. The CloudFront origin the `Hosting` construct injects for you is always escaped and anchored automatically.

If an origin doesn't match any pattern, the handler omits the `Access-Control-Allow-Origin` header (browser blocks the response) and logs a `[CORS]` warning to CloudWatch.

## Committed baselines (`aws-blocks/baselines/`)

Some Building Blocks refuse a destructive change at synth by comparing it with a **baseline file** they write into your app: `aws-blocks/baselines/<stack>/<file>.json`, next to the backend handler file the stack was created with. `Auth` is the first: it records the user-pool settings that Cognito cannot change after the pool exists.

- **Commit these files.** The check only protects a synth that sees them; a fresh checkout without them starts a new baseline from whatever the configuration is now.
- **Renaming or removing a block** whose baseline says it owns a stateful resource fails synth on every `BlocksStack` / `BlocksBackend`, even when the block's package is no longer imported. The message names what CloudFormation would delete and the re-baseline variable to set if the removal is intended.
- **The format is versioned.** Every file has a top-level `version` (currently `1`; a file without one is read as `1`), a `fullId` naming the block that owns it, and, while that block owns a stateful resource, a `removalGuard`. The rest of the file belongs to the block that wrote it. Every later release keeps reading every earlier version. A file with a higher version than this release knows fails synth with a message to upgrade `@aws-blocks/core` and `@aws-blocks/blocks`; a file whose `version` is not a whole number from 1 fails synth as invalid (restore it from version control). Neither is ever rewritten or deleted.

Building Block authors: the protocol (`claimBaseline`, `baselineDir`, `hasOrphanedBaselines`, `BASELINE_FORMAT_VERSION`) is framework-internal and lives in `@aws-blocks/core/cdk/internal`; see `src/cdk/baselines.ts`.

## IAM: permissions boundary and the composed-policy report

Every Blocks compute (the API handler, raw routes, queue/cron/WebSocket handlers, the agent runtime) runs as **one shared execution role**, and every Building Block grants its permissions onto that role. The role is therefore the union of what all your blocks need.

### See what the role holds: `<stack>.blocks-iam.json`

Every synth writes a report of the shared role's composed policy next to the template in `cdk.out/`: `<stackName>.blocks-iam.json` for a `BlocksStack`, or `<stackName>.<backendId>.blocks-iam.json` for each embedded `BlocksBackend`. It lists every statement (actions, resources, conditions), the managed policies and the boundary in force, plus an inventory (`roles`) of every IAM role Blocks created, each with its boundary and tags exactly as the template carries them. Each statement carries a `blocks` field: the `fullId`s of the Building Blocks that own the resources it references. The file is sorted and deterministic, so a CI step can diff it against the previous build and fail when an app's permissions grow unexpectedly:

```bash
NODE_OPTIONS="--conditions=cdk" npx cdk synth --quiet
jq '.executionRole.statements[] | {actions, blocks}' cdk.out/my-app.blocks-iam.json
```

The report is CDK-only and doesn't change the CloudFormation template.

The file is written on **every** synth, whether or not `permissionsBoundary` is set, so expect it in `cdk.out/` if you check that directory's contents. It's a side file only: it isn't part of any CloudFormation template and isn't listed as a cloud-assembly artifact in `cdk.out/manifest.json`, so it isn't deployed and `cdk diff` (which compares stack templates) doesn't see it. Producing it costs one walk over the stack's constructs per synth, which is small next to bundling.

### Cap every role: `defaults.permissionsBoundary`

A [permissions boundary](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) is a ceiling: a role's effective permissions are the intersection of its policies and the boundary. Set `defaults.permissionsBoundary` to attach one to **every** IAM role AWS Blocks creates: the shared execution role, block-owned helper roles, the CDK custom-resource roles blocks cause, and `Hosting`'s roles (including the Lambda@Edge and CloudFront-monitoring roles in the separate `us-east-1` stacks).

```typescript
// aws-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' },
});
```

Pass the policy's name (resolved in the deploying account), its full ARN (required when the policy has a path), or an `iam.IManagedPolicy`. The option is unset in both presets, and unset leaves templates unchanged.

This is the hook a platform needs when many apps deploy through one pipeline: the platform restricts its CloudFormation execution role so that `iam:CreateRole` / `iam:PutRolePolicy` are allowed only with an `iam:PermissionsBoundary` condition naming its boundary, and each app sets `permissionsBoundary` to that policy. A role created without it fails the deploy.

- **Scope.** On a `BlocksStack` the boundary covers every role in the stack. On an embedded `BlocksBackend` it covers the backend's subtree plus the stack-level CDK singleton roles its blocks add; roles your stack already had are left alone. Bound those, and any other stack, yourself with `iam.PermissionsBoundary.of(stack).apply(policy)`.
- **With CDK's `@aws-cdk/core:permissionsBoundary` context.** The context bounds every role in the app. When both are set, `defaults.permissionsBoundary` wins for the roles Blocks creates and synth warns. Set the context in `cdk.json` (the `-c '@aws-cdk/core:permissionsBoundary={"name":"…"}'` CLI form passes a string, which CDK ignores). The context doesn't reach the cross-region-reference provider roles CDK adds while preparing the app, such as the ones off-region `Hosting` causes; `defaults.permissionsBoundary` does.
- **What it doesn't do.** A boundary caps the shared role; it doesn't split it. Every handler still runs as the same role, so a bug in one block can still use another block's grants, up to the boundary. Separately deployed apps that need isolation from each other belong in separate AWS accounts.

### Running many apps in one AWS account (a shared platform)

Some platforms deploy many independently written apps, often generated by AI (artificial intelligence) coding agents, through one CI (continuous integration) pipeline into **one AWS account**. Each app's CDK (Cloud Development Kit) code decides the permissions of its own roles. Nothing in the app stops it from granting itself another app's resources: a single `AppSetting.fromExisting(scope, 'x', { name: '/appb-db-password', secret: true })` gives App A read access to App B's secret, and the deploy succeeds.

**The strongest isolation is one AWS account per app** (AWS Organizations with SCPs (service control policies)). When apps must share an account, the platform enforces a per-app ceiling with IAM (Identity and Access Management), outside the apps' code. AWS Blocks provides the app side of it with one option, `defaults.app`. The platform team writes and owns the IAM policies; this section documents what they contain:

| Part | Who provides it | How |
|---|---|---|
| 1. An identity on everything the app creates | AWS Blocks | `defaults.app: { id }` tags every resource and role `app=<id>`, and every name it derives starts with `<id>-` |
| 2. A boundary on every role the app creates | AWS Blocks | `defaults.permissionsBoundary` |
| 3. The boundary policy, shared by every app | The platform | [The shared permissions boundary](#the-shared-permissions-boundary) |
| 4. A per-app CloudFormation execution role that only creates bounded roles tagged as the app | The platform | [The per-app execution policy](#the-per-app-execution-policy) |
| 5. A deploy guard that keeps each app's deploy role on its own stacks | The platform | [The deploy guard](#the-deploy-guard) |
| 6. A pipeline step before credentials are issued | The platform | [The pipeline](#the-pipeline): synth with `strict: true`, and the report's `app.id` |

Parts 1 and 2 live in each app's code. A platform team puts them in its own project template once, so no app has to remember them: see [The app's side: what to put in your project template](#the-apps-side-what-to-put-in-your-project-template).

**1–2. In each app.** Name the stack after the app id, and set the identity and the boundary:

```typescript
// aws-blocks/index.cdk.ts — the app id comes from the platform's pipeline, not the app's code
export const blocksStack = await BlocksStack.create(app, process.env.APP_ID!, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...BlocksPresets.production,
    app: { id: process.env.APP_ID!, strict: true },
    permissionsBoundary: 'apps-boundary',
  },
});
```

- **The id** is 1–10 lowercase letters and digits, starting with a letter. No hyphen, so one app's prefix (`appa-`) never matches another app's names (`appab-…`). At most 10 characters because the id is also the app's CDK bootstrap qualifier (CDK's limit is 10): every app has its own bootstrap, and no two apps can share one. **Some ids are reserved**, because the app's `<id>-…` / `<id>/…` names, which the platform's policies give the app, would include names other apps, AWS Blocks, CDK or AWS share:

  | Reserved | Why |
  |---|---|
  | `cdk` | every app's CDK bootstrap (`cdk-<qualifier>-assets-…` buckets, `cdk-<qualifier>-…-role-…` roles, `/cdk-bootstrap/<qualifier>/…`) and CDK's `/cdk/exports/…` and `/cdk/EdgeFunctionArn/…` parameters |
  | `blocks` | every app's Hosting `secret()` / `config()` values (`blocks/<id>/…`) |
  | `secrets`, `config` | Hosting's values for apps without a `stackId` (`blocks/secrets/…`, `/blocks/config/…`); `config` also AWS Config's default bucket (`config-bucket-<account>`) |
  | `amplify` | AWS Amplify's stacks and the resources in them (`amplify-…`) |
  | `cf` | the CloudFormation console's template buckets (`cf-templates-…`) |
  | `sagemaker` | SageMaker's default buckets (`sagemaker-<region>-<account>`) |
  | `af`, `ap`, `ca`, `cn`, `eu`, `eusc`, `il`, `me`, `mx`, `sa`, `us` | region prefixes: CDK names a CloudFront Function `<region><construct id>` (`us-east-1MyStack…`), so `function/us-*` would match every such function |
  | any id starting with `aws` | names AWS reserves (`aws-…` buckets, stacks, roles and log groups, `/aws/…` parameters, Elastic Beanstalk's `awseb-…` stacks) |
  | any id starting with `ssm` | Systems Manager rejects parameter names that start with `ssm`, so the app couldn't create its own |

  Synth (`defaults.app`) rejects them, saying why. The platform's registry should reject them too, before it hands an id out.
- **Names.** Every Building Block derives its resource names (tables, queues, buckets, parameters, schedules, user pools) from its `fullId`, which starts with the stack's id, and CloudFormation-generated names (functions, roles, topics, alarms, managed policies) start with the stack name. So with the stack named `<id>` or `<id>-…`, every name starts with `<id>-`. Developers don't name anything themselves. AWS Blocks also names the Lambda layers (`<id>-<logical id>`) and the CloudFront Functions and KeyValueStores (`<id>-<region>-…`) it creates (CDK's default names don't put a `-` after the id), unless the app chose a name itself.
- **Hosting `secret()` and `config()`.** Their values are named `blocks/<stackId>/secrets/…` (Secrets Manager) and `/blocks/<stackId>/config/…` (SSM (AWS Systems Manager)), where `stackId` comes from `.blocks/config.json`. Under `defaults.app`, set `stackId` to the app id: the boundary allows `blocks/<id>/…` by name, so the values `npm run secret` / `npm run config` create untagged still work, and the IAM report treats any other `blocks/…` name as outside the app, with a hint to fix `stackId`.
- **Tags.** `app=<id>` goes on every resource CloudFormation creates for the app and every IAM role AWS Blocks creates, including the CDK custom-resource provider roles that `Tags.of()` doesn't reach, at a priority above the default `Tags.of(...).add()`. It also goes on `Hosting` and on the separate stacks Hosting adds (the `us-east-1` CloudFront alarm stack `<id>-CfMonitoring-…` and the Lambda@Edge stack `<id>-edge`), as a stack tag too, which CloudFormation propagates to what a tag aspect can't reach. An app can still raise its own priority or remove the tag; the execution role (part 4) rejects any role not tagged `<id>`. SecureString parameters that AWS Blocks' secret initializer creates at deploy time carry only the `aws-blocks-stack` tag; SSM is scoped by name, so that's no gap.
- **The boundary** goes on every role AWS Blocks creates, including the CDK helper roles and the roles CDK adds while preparing the app, which CDK's own `@aws-cdk/core:permissionsBoundary` context misses.
- **The IAM report** (`cdk.out/<stack>.blocks-iam.json`) gains an `app` section and a `violations` list: a role without the boundary or the app tag; a grant on a name outside the app's prefix (for example `fromExisting` on another app's parameter); a wildcard grant on a data service; an "everything except" grant (`NotAction`, `NotResource`); a resource the check can't resolve (`Fn::Sub` on a parameter, `Fn::ImportValue`, a template parameter) — these fail closed; a resource policy that opens up another app's resource; a role that trusts anything but an AWS service; a broad AWS managed policy (`AdministratorAccess`, `*FullAccess`); the CDK asset bucket of another bootstrap; a grant on a literal API id, or an API Gateway stage, route or deployment attached to an API that isn't in the app's own template (`api-outside-app`); or a stack or block outside the prefix. With `strict: true`, synth fails on any violation. Without it, synth prints a one-line summary.

The report and `strict` are fast feedback for developers and their agents. They aren't the boundary: the app's own code runs at synth, so a determined app could get around them. The boundary is IAM, in parts 3–5.

**3–5. The platform's policies.** The platform writes these three policies and owns them: AWS Blocks never creates, changes or reads them. The examples below are for app `appa` in account `APPS_ACCOUNT` (replace both, and `aws` in the ARNs for another partition). Review them and test them on a deployed app in a sandbox account before relying on them.

#### The shared permissions boundary

One managed policy for every app in the account, created once as `apps-boundary` and set as each app's `defaults.permissionsBoundary`. It's an **allow-list** keyed on the calling role's `app` tag (`${aws:PrincipalTag/app}`, which IAM resolves at request time), so one document serves every app. A service it has no statement for is denied, and IAM, Organizations and STS (Security Token Service) role assumption are never allowed:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OwnParameters",
      "Effect": "Allow",
      "Action": "ssm:*",
      "Resource": [
        "arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}",
        "arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}-*",
        "arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}/*",
        "arn:aws:ssm:*:*:parameter/cdk/exports/${aws:PrincipalTag/app}",
        "arn:aws:ssm:*:*:parameter/cdk/exports/${aws:PrincipalTag/app}-*",
        "arn:aws:ssm:*:*:parameter/cdk/exports/${aws:PrincipalTag/app}/*",
        "arn:aws:ssm:*:*:parameter/cdk/EdgeFunctionArn/*/${aws:PrincipalTag/app}/*",
        "arn:aws:ssm:*:*:parameter/blocks/${aws:PrincipalTag/app}/*"
      ]
    },
    {
      "Sid": "OwnHostingSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:*",
      "Resource": [
        "arn:aws:secretsmanager:*:*:secret:blocks/${aws:PrincipalTag/app}/*"
      ]
    },
    {
      "Sid": "OwnTables",
      "Effect": "Allow",
      "Action": "dynamodb:*",
      "Resource": [
        "arn:aws:dynamodb:*:*:table/${aws:PrincipalTag/app}-*",
        "arn:aws:dynamodb:*:*:table/${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "OwnQueues",
      "Effect": "Allow",
      "Action": "sqs:*",
      "Resource": [
        "arn:aws:sqs:*:*:${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnBuckets",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${aws:PrincipalTag/app}-*",
        "arn:aws:s3:::${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "ReadOwnCdkAssets",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-*",
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-*/*"
      ]
    },
    {
      "Sid": "OwnFunctions",
      "Effect": "Allow",
      "Action": "lambda:*",
      "Resource": [
        "arn:aws:lambda:*:*:function:${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnLogs",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": [
        "arn:aws:logs:*:*:log-group:${aws:PrincipalTag/app}-*",
        "arn:aws:logs:*:*:log-group:/aws/lambda/${aws:PrincipalTag/app}-*",
        "arn:aws:logs:*:*:log-group:/aws/rds/cluster/${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "AgentCoreRuntimeLogsWriteOnly",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": [
        "arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/runtimes/*"
      ]
    },
    {
      "Sid": "OwnStacksRead",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeStacks",
        "cloudformation:GetTemplate"
      ],
      "Resource": [
        "arn:aws:cloudformation:*:*:stack/${aws:PrincipalTag/app}/*",
        "arn:aws:cloudformation:*:*:stack/${aws:PrincipalTag/app}-*/*"
      ]
    },
    {
      "Sid": "OwnSchedules",
      "Effect": "Allow",
      "Action": "scheduler:*",
      "Resource": [
        "arn:aws:scheduler:*:*:schedule/*/${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnEvents",
      "Effect": "Allow",
      "Action": "events:*",
      "Resource": [
        "arn:aws:events:*:*:rule/${aws:PrincipalTag/app}-*",
        "arn:aws:events:*:*:event-bus/${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnDatabases",
      "Effect": "Allow",
      "Action": [
        "rds-data:*",
        "rds:*"
      ],
      "Resource": [
        "arn:aws:rds:*:*:cluster:${aws:PrincipalTag/app}-*",
        "arn:aws:rds:*:*:db:${aws:PrincipalTag/app}-*"
      ]
    },
    {
      "Sid": "OwnTaggedResources",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:*",
        "states:*",
        "cognito-idp:*",
        "kms:*",
        "bedrock:*",
        "bedrock-agentcore:*",
        "dsql:*",
        "s3vectors:*",
        "cloudfront:*",
        "cloudfront-keyvaluestore:*"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "AgentCoreDefaultDirectory",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
        "bedrock-agentcore:GetWorkloadAccessTokenForUserId"
      ],
      "Resource": "arn:aws:bedrock-agentcore:*:*:workload-identity-directory/default"
    },
    {
      "Sid": "AwsOwnedModelsRead",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetFoundationModel",
        "bedrock:GetInferenceProfile"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/*",
        "arn:aws:bedrock:*:*:inference-profile/*"
      ]
    },
    {
      "Sid": "ManagedKeysViaService",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey*",
        "kms:DescribeKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "kms:ViaService": [
            "ssm.*.amazonaws.com",
            "secretsmanager.*.amazonaws.com",
            "dynamodb.*.amazonaws.com",
            "s3.*.amazonaws.com",
            "sqs.*.amazonaws.com"
          ]
        }
      }
    },
    {
      "Sid": "ResourcelessActions",
      "Effect": "Allow",
      "Action": [
        "xray:PutTraceSegments",
        "xray:PutTelemetryRecords",
        "xray:GetSamplingRules",
        "xray:GetSamplingTargets",
        "cloudwatch:PutMetricData",
        "logs:DescribeLogGroups",
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
        "ec2:AssignPrivateIpAddresses",
        "ec2:UnassignPrivateIpAddresses",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
        "ec2:DescribeSecurityGroups",
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles",
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:SendBulkEmail"
      ],
      "Resource": "*"
    }
  ]
}
```

What each group of statements is for:

- **By name prefix** (`OwnParameters` to `OwnDatabases`): SSM parameters, DynamoDB tables, SQS queues, S3 (Amazon Simple Storage Service) buckets, Lambda functions, log groups (including `/aws/lambda/<id>-…` and a Database's `/aws/rds/cluster/<id>-…`), schedules, event rules and buses, and RDS clusters and instances named under the app's prefix (`<id>-…`; parameters also `<id>` and `<id>/…`). AWS Blocks guarantees those names under `defaults.app`. `OwnStacksRead` lets a table's index manager read its own stack. `OwnParameters` also covers CDK's cross-region references for the app's own stacks (`/cdk/exports/<id>…`), the Lambda@Edge ARNs CDK publishes for Hosting (`/cdk/EdgeFunctionArn/<region>/<id>/…`) and Hosting's `config()` values (`/blocks/<id>/…`); `OwnHostingSecrets` covers Hosting's `secret()` values (`blocks/<id>/…`), which the CLI creates untagged.
- **The app's own CDK assets** (`ReadOwnCdkAssets`): read-only access to its own bootstrap's asset bucket (qualifier = app id), which `BucketDeployment` reads.
- **By the resource's `app` tag** (`OwnTaggedResources`): Secrets Manager, Step Functions, Cognito, KMS (Key Management Service), Bedrock, AgentCore, DSQL (Aurora DSQL), S3 Vectors and CloudFront resources are named by id, not by a name the app controls, so they're matched by `aws:ResourceTag/app`.
- **Exceptions with no app scope, each as narrow as the service allows:** `AgentCoreRuntimeLogsWriteOnly` (AgentCore runtimes log to AWS-named groups, write only); `AgentCoreDefaultDirectory` (workload access tokens from the account's `default` directory; the workload identity itself stays tag-scoped); `AwsOwnedModelsRead` (metadata of AWS-owned foundation models and system-defined inference profiles, not application inference profiles, which are tag-scoped); `ManagedKeysViaService` (AWS-managed keys, only through SSM, Secrets Manager, DynamoDB, S3 and SQS); and `ResourcelessActions` (actions that take only `*`: X-Ray, `PutMetricData`, `DescribeLogGroups`, VPC network interfaces, model invocation and listing, SES).

It is about 4,600 characters, below IAM's 6,144-character limit for a managed policy.

**A per-app boundary for `execute-api`.** A Realtime WebSocket API's `ManageConnections` (which Realtime publish/subscribe and every Agent's streaming use) and an IAM-authorized API's `Invoke` can't be scoped by name or tag, so the shared boundary denies them: under `apps-boundary` alone, those Building Blocks fail at runtime. Allowing them account-wide would let App A post to App B's WebSocket clients — and B's typed handlers receive the injected message as genuine — or drop B's connections. Give an app that uses Realtime or Agent its own boundary, `apps-boundary-<id>`, from its first deploy: the shared statements plus one more, listing the ids of the app's own APIs:

```json
{
  "Sid": "OwnApis",
  "Effect": "Allow",
  "Action": [
    "execute-api:ManageConnections",
    "execute-api:Invoke"
  ],
  "Resource": [
    "arn:aws:execute-api:*:*:API_ID/*"
  ]
}
```

Until the APIs exist, leave the statement out. Once they do, add their ids (one `arn:aws:execute-api:*:*:<api id>/*` each) and update the policy: a boundary change applies at once, with no redeploy. Set `apps-boundary-<id>` as that app's `permissionsBoundary`, and name it in the app's execution policy (`RolesOnlyWithTheBoundary`, `NoEditingTheBoundary`) instead of `apps-boundary`. To find the apps that need one, look for `execute-api:` actions in their IAM reports: `jq '[.executionRole.statements[] | select(any(.actions[]?; startswith("execute-api:")))] | length' cdk.out/*.blocks-iam.json`.

#### The per-app execution policy

Each app is bootstrapped with its own qualifier, and its CDK bootstrap execution role (the role CloudFormation deploys the app's stacks as) gets this policy instead of `AdministratorAccess`:

```bash
cdk bootstrap aws://APPS_ACCOUNT/us-east-1 --qualifier appa --toolkit-stack-name CDKToolkit-appa \
  --cloudformation-execution-policies arn:aws:iam::APPS_ACCOUNT:policy/apps-exec-appa
```

Set the same `@aws-cdk/core:bootstrapQualifier` and `toolkitStackName` in the app's `cdk.json`. The policy has two parts.

**The role fence**, the same for every app (with its id). It can only create roles that carry the boundary, are named `appa-…` and are tagged `app=appa`; it can never remove the boundary, edit the boundary policy, re-tag a role to another app or untag it, or attach a broad AWS managed policy; and it reads only its own bootstrap's version parameter and asset bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RolesOnlyWithTheBoundary",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePermissionsBoundary"
      ],
      "Resource": "arn:aws:iam::APPS_ACCOUNT:role/appa-*",
      "Condition": {
        "StringEquals": {
          "iam:PermissionsBoundary": "arn:aws:iam::APPS_ACCOUNT:policy/apps-boundary"
        }
      }
    },
    {
      "Sid": "RoleLifecycle",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:DeleteRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:UpdateRoleDescription",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::APPS_ACCOUNT:role/appa-*"
    },
    {
      "Sid": "RequireThisAppsTag",
      "Effect": "Deny",
      "Action": "iam:CreateRole",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "appa"
        }
      }
    },
    {
      "Sid": "NoRetaggingToAnotherApp",
      "Effect": "Deny",
      "Action": "iam:TagRole",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "appa"
        },
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        }
      }
    },
    {
      "Sid": "NoUntaggingApp",
      "Effect": "Deny",
      "Action": "iam:UntagRole",
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        }
      }
    },
    {
      "Sid": "KeepTheBoundary",
      "Effect": "Deny",
      "Action": "iam:DeleteRolePermissionsBoundary",
      "Resource": "*"
    },
    {
      "Sid": "NoEditingTheBoundary",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion"
      ],
      "Resource": "arn:aws:iam::APPS_ACCOUNT:policy/apps-boundary"
    },
    {
      "Sid": "NoBroadManagedPolicies",
      "Effect": "Deny",
      "Action": "iam:AttachRolePolicy",
      "Resource": "*",
      "Condition": {
        "ArnLike": {
          "iam:PolicyARN": [
            "arn:aws:iam::aws:policy/AdministratorAccess",
            "arn:aws:iam::aws:policy/PowerUserAccess",
            "arn:aws:iam::aws:policy/IAMFullAccess",
            "arn:aws:iam::aws:policy/*FullAccess"
          ]
        }
      }
    },
    {
      "Sid": "ReadOwnBootstrapVersion",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": [
        "arn:aws:ssm:*:APPS_ACCOUNT:parameter/cdk-bootstrap/appa/*"
      ]
    },
    {
      "Sid": "ReadOwnBootstrapAssets",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:GetBucket*"
      ],
      "Resource": [
        "arn:aws:s3:::cdk-appa-assets-APPS_ACCOUNT-*",
        "arn:aws:s3:::cdk-appa-assets-APPS_ACCOUNT-*/*"
      ]
    }
  ]
}
```

`RoleLifecycle` has no boundary condition, so `iam:PassRole` and `iam:DeleteRole` work on the app's existing roles; every role it can create already carries the boundary. `NoRetaggingToAnotherApp` denies only a tag write that sets `app`, so other tag updates still work.

**Per-service rules.** Add statements only for the resource types the app's templates use (`jq -rs '[.[].Resources[]?.Type] | unique[]' cdk.out/*.template.json`), each scoped to the app's names or its `app` tag. `<id>` below is the app id, spelled out (`appa`), not a policy variable, and `ACCOUNT` is the account id:

| Resource types | Scoped by |
|---|---|
| `AWS::Lambda::Function`, `Permission`, `Version`, `Alias`, `Url`, `EventInvokeConfig` | `lambda:*` on `arn:aws:lambda:*:ACCOUNT:function:<id>-*`, plus `lambda:GetAccountSettings` on `*` (read-only) |
| `AWS::Lambda::LayerVersion`, `LayerVersionPermission` | `lambda:PublishLayerVersion`, `DeleteLayerVersion`, `GetLayerVersion` on `layer:<id>-*` and `layer:<id>-*:*` |
| `AWS::Lambda::EventSourceMapping` | the mapping actions on `*` with `ArnLike` `lambda:FunctionArn` = `function:<id>-*`; tag writes on `event-source-mapping:*` with the request tag `app=<id>` on create and the resource tag after |
| `AWS::Logs::LogGroup`, `LogStream`, `SubscriptionFilter`, `MetricFilter`, `Custom::LogRetention` | `logs:*` on `log-group:<id>-*`, `log-group:/aws/lambda/<id>-*`, `log-group:/aws/rds/cluster/<id>-*`; `logs:DescribeLogGroups` on `*` |
| `AWS::DynamoDB::Table`, `GlobalTable` | `dynamodb:*` on `table/<id>-*` and `table/<id>-*/*` |
| `AWS::SQS::Queue`, `QueuePolicy` | `sqs:*` on `arn:aws:sqs:*:ACCOUNT:<id>-*` |
| `AWS::S3::Bucket`, `BucketPolicy` | `s3:*` on `arn:aws:s3:::<id>-*` and `arn:aws:s3:::<id>-*/*` |
| `AWS::SSM::Parameter` | `ssm:*` on `parameter/<id>`, `parameter/<id>-*`, `parameter/<id>/*`, `parameter/cdk/EdgeFunctionArn/*/<id>/*` |
| `Custom::CrossRegionExportReader`, `ExportWriter`, `StringParameterReader` | `ssm:GetParameter`, `GetParameters` on `parameter/cdk/exports/<id>`, `<id>-*`, `<id>/*` |
| `AWS::Scheduler::Schedule` | `scheduler:*` on `schedule/*/<id>-*` |
| `AWS::Events::Rule` | `events:*` on `rule/<id>-*` |
| `AWS::SNS::Topic`, `TopicPolicy`, `Subscription` | `sns:*` on `arn:aws:sns:*:ACCOUNT:<id>-*` |
| `AWS::CloudWatch::Alarm` | `PutMetricAlarm`, `DescribeAlarms`, `DeleteAlarms` and the tag actions on `alarm:<id>-*` |
| `AWS::CloudWatch::Dashboard` | `PutDashboard`, `GetDashboard`, `DeleteDashboards` on `dashboard/<id>-*` |
| `AWS::IAM::ManagedPolicy` (AWS Blocks' `BlocksRoleOverflowPolicy*`) | the policy and policy-version actions on `arn:aws:iam::ACCOUNT:policy/<id>-*` (attachable only to the app's roles, through the fence) |
| `AWS::ResourceGroups::Group` | `resource-groups:*` on `group/<id>-*`; `cloudformation:DescribeStacks`, `ListStackResources`, `tag:GetResources` on `*` |
| `AWS::S3Vectors::VectorBucket`, `Index`, `VectorBucketPolicy` | `s3vectors:*` on `bucket/<id>-*` and `bucket/<id>-*/index/*` |
| `AWS::RDS::DBCluster`, `DBInstance`, `DBSubnetGroup`, `DBClusterParameterGroup`, `DBParameterGroup`, `OptionGroup` | `rds:*` on `cluster:`, `db:`, `subgrp:`, `cluster-pg:`, `pg:`, `og:`, `cluster-snapshot:` and `snapshot:<id>-*`; create and modify against RDS's `default…` parameter and option groups; `ec2:Describe*` on `*` |
| `AWS::CloudFront::Function` | the function actions on `arn:aws:cloudfront::ACCOUNT:function/<id>-*` |
| `AWS::SecretsManager::Secret`, `SecretTargetAttachment`, `ResourcePolicy`, `RotationSchedule` | tag (five statements, below), plus `secretsmanager:GetRandomPassword` on `*` (it reads nothing) |
| `AWS::ApiGateway::*` (APIs and their children) and `AWS::ApiGatewayV2::*` | tag (five statements, below), plus `apigateway:UpdateRestApiPolicy` on the `/restapis` collection; pin to the app's API ids once they exist |
| `AWS::Cognito::UserPool*` | tag |
| `AWS::KMS::Key`, `Alias` | tag; aliases by name, `alias/<id>-*` |
| `AWS::StepFunctions::StateMachine` | tag, on `stateMachine:*` and `execution:*` |
| `AWS::DSQL::Cluster` | tag |
| `AWS::Bedrock::KnowledgeBase`, `DataSource` | tag (a data source is authorized against its knowledge base) |
| `AWS::EC2::VPC`, `Subnet`, `RouteTable`, `Route`, `SubnetRouteTableAssociation`, `SecurityGroup*`, `InternetGateway`, `VPCGatewayAttachment`, `NatGateway`, `EIP` | tag; creating a subnet, route table or security group, or attaching an internet gateway, also requires the VPC to be tagged `app=<id>`; security-group rules on `security-group-rule/*`; `ec2:Describe*` on `*` |
| `AWS::CloudFront::Distribution` | tag |
| `AWS::CloudFront::KeyValueStore` | tag (the create and manage statements; the denies on `cloudfront:*` come with the distribution's) |
| `AWS::CloudFront::OriginAccessControl`, `CachePolicy`, `OriginRequestPolicy`, `ResponseHeadersPolicy` | **can't be scoped** (see below) |
| `AWS::BedrockAgentCore::Runtime` | **not scoped** (see below) |
| `AWS::IAM::Role`, `Policy`, `RolePolicy`, `AWS::CDK::Metadata`, custom resources, wait conditions | the role fence; nothing else needed |

**Tag-scoped services: five statements each.** A service whose resources are named by id can't be scoped by name, so it's scoped by the `app` tag, and a request tag alone never grants access to an existing resource: **Create** only top-level resources, only tagged `app=<id>`; **Manage** only resources (and their children, which are authorized against their parent's tag) already tagged `app=<id>`, tag writes included, so an untagged resource can't be claimed; deny anything on a resource tagged as **another app** (`NotAnotherApps`); and deny any tag write that sets `app` to another value (`NoRetagging`) or removes it (`NoUntagging`). For API Gateway (REST, HTTP and WebSocket APIs):

```json
[
  {
    "Sid": "ApisCreate",
    "Effect": "Allow",
    "Action": [
      "apigateway:POST",
      "apigateway:TagResource"
    ],
    "Resource": [
      "arn:aws:apigateway:*::/restapis",
      "arn:aws:apigateway:*::/apis"
    ],
    "Condition": {
      "StringEquals": {
        "aws:RequestTag/app": "appa"
      }
    }
  },
  {
    "Sid": "ApisManage",
    "Effect": "Allow",
    "Action": [
      "apigateway:GET",
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:PATCH",
      "apigateway:DELETE",
      "apigateway:UpdateRestApiPolicy",
      "apigateway:TagResource",
      "apigateway:PUT",
      "apigateway:UntagResource",
      "apigateway:DELETE"
    ],
    "Resource": [
      "arn:aws:apigateway:*::/restapis/*",
      "arn:aws:apigateway:*::/apis/*",
      "arn:aws:apigateway:*::/tags/*"
    ],
    "Condition": {
      "StringEquals": {
        "aws:ResourceTag/app": "appa"
      }
    }
  },
  {
    "Sid": "ApisNotAnotherApps",
    "Effect": "Deny",
    "Action": "apigateway:*",
    "Resource": "*",
    "Condition": {
      "StringNotEquals": {
        "aws:ResourceTag/app": "appa"
      },
      "Null": {
        "aws:ResourceTag/app": "false"
      }
    }
  },
  {
    "Sid": "ApisNoRetagging",
    "Effect": "Deny",
    "Action": [
      "apigateway:TagResource",
      "apigateway:PUT"
    ],
    "Resource": "*",
    "Condition": {
      "StringNotEquals": {
        "aws:RequestTag/app": "appa"
      },
      "ForAnyValue:StringEquals": {
        "aws:TagKeys": [
          "app"
        ]
      }
    }
  },
  {
    "Sid": "ApisNoUntagging",
    "Effect": "Deny",
    "Action": [
      "apigateway:UntagResource",
      "apigateway:DELETE"
    ],
    "Resource": "*",
    "Condition": {
      "ForAnyValue:StringEquals": {
        "aws:TagKeys": [
          "app"
        ]
      }
    }
  },
  {
    "Sid": "ApisPolicyOnCreate",
    "Effect": "Allow",
    "Action": "apigateway:UpdateRestApiPolicy",
    "Resource": [
      "arn:aws:apigateway:*::/restapis"
    ]
  }
]
```

The other tag-scoped services follow the same pattern with their own actions: for example Secrets Manager creates with `secretsmanager:CreateSecret` on `*`, manages `secretsmanager:*` on `arn:aws:secretsmanager:*:ACCOUNT:secret:*`, and tags with `secretsmanager:TagResource` / `UntagResource`. **Don't treat API Gateway as isolated on its tag alone.** Before the app's first deploy, an API's children (stages, deployments, routes) are authorized against their parent API's `app` tag; once the app's APIs exist, pin `ApisManage` to them by replacing its `Resource` with, for each of the app's API ids, `arn:aws:apigateway:*::/restapis/<api id>`, `arn:aws:apigateway:*::/restapis/<api id>/*`, `arn:aws:apigateway:*::/apis/<api id>`, `arn:aws:apigateway:*::/apis/<api id>/*` and `arn:aws:apigateway:*::/tags/*<api id>*`.

**Service-linked roles.** The first deploy of some services in an account creates their service-linked role. Allow `iam:CreateServiceLinkedRole` on `arn:aws:iam::ACCOUNT:role/aws-service-role/*` with `StringEquals` `iam:AWSServiceName` listing only the services the app uses: `rds.amazonaws.com` (RDS), `dsql.amazonaws.com` (DSQL), `runtime-identity.bedrock-agentcore.amazonaws.com` (AgentCore runtimes).

**CloudFront configuration types can't be scoped.** CloudFront origin access controls and cache, origin-request and response-headers policies are named by id and support no tag condition, so no statement can scope them to one app. Granting their `Create`, `Get`, `Get…Config`, `Update` and `Delete` actions on `origin-access-control/*`, `cache-policy/*`, `origin-request-policy/*` and `response-headers-policy/*` is an accepted exception: they hold configuration, not data, but App A's deploy could change or delete one of App B's. If that's not acceptable, leave them out and deploy those resources from the platform.

**AgentCore runtimes aren't scoped.** CloudFormation creates each runtime's workload identity in the account-wide `default` directory, which carries no app tag, and a runtime's name can't carry `<id>-` (no hyphens allowed), so no statement scopes `AWS::BedrockAgentCore::Runtime` to one app. Its service-linked role (above) is still needed. A platform that accepts the risk adds `bedrock-agentcore` statements by hand. Likewise `AWS::ApiGateway::Account` is an account-level setting shared by every app in the region; set it from the platform.

**Size.** IAM limits a managed policy to 6,144 characters, not counting white space. An app that uses many services goes over it: split the statements, whole and in order, into several policies (staying around 5,000 characters each leaves room to add statements later without another policy and a re-bootstrap), and pass them all, comma-separated, to `cdk bootstrap --cloudformation-execution-policies`.

#### The deploy guard

CDK's default bootstrap deploy role may change or delete *any* stack, and CloudFormation reuses a stack's previous service role when a request omits one, so without a guard App A's pipeline could deploy into — or delete — App B's stack as App B's execution role. The guard goes on the app's CDK bootstrap **deploy** role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyThisAppsStacks",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:CancelUpdateStack",
        "cloudformation:ContinueUpdateRollback",
        "cloudformation:RollbackStack",
        "cloudformation:SetStackPolicy",
        "cloudformation:UpdateTerminationProtection",
        "cloudformation:SignalResource",
        "cloudformation:GetTemplate"
      ],
      "NotResource": [
        "arn:aws:cloudformation:*:APPS_ACCOUNT:stack/appa/*",
        "arn:aws:cloudformation:*:APPS_ACCOUNT:stack/appa-*/*"
      ]
    },
    {
      "Sid": "OnlyThisAppsExecutionRole",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotLike": {
          "cloudformation:RoleArn": "arn:aws:iam::APPS_ACCOUNT:role/cdk-appa-cfn-exec-role-APPS_ACCOUNT-*"
        }
      }
    },
    {
      "Sid": "DeleteOnlyWithThisAppsExecutionRole",
      "Effect": "Deny",
      "Action": "cloudformation:DeleteStack",
      "Resource": "*",
      "Condition": {
        "StringNotLike": {
          "cloudformation:RoleArn": "arn:aws:iam::APPS_ACCOUNT:role/cdk-appa-cfn-exec-role-APPS_ACCOUNT-*"
        },
        "Null": {
          "cloudformation:RoleArn": "false"
        }
      }
    }
  ]
}
```

- `OnlyThisAppsStacks` denies stack changes outside `appa` and `appa-…` — including the app's own bootstrap stack (`CDKToolkit-appa`), which only the platform re-bootstraps.
- `OnlyThisAppsExecutionRole` denies creating or changing a stack without naming App A's own execution role, so CloudFormation can't fall back to another stack's role.
- `DeleteOnlyWithThisAppsExecutionRole`: deleting one of the app's own stacks may omit the role — CDK does so when it cleans up a failed first deploy (`ROLLBACK_COMPLETE`) — but a role it names must be App A's own. That's safe: `OnlyThisAppsStacks` confines `DeleteStack` to `appa` / `appa-…` stacks, and those can only have been created with App A's own execution role, which is the role CloudFormation reuses.

**Prefer putting its statements in a custom bootstrap template** (`cdk bootstrap --show-template`, add them to the deploy role, `cdk bootstrap --template <file>`), so CloudFormation owns them; attaching it to the existing deploy role (`cdk-appa-deploy-role-<account>-<region>`) works, but it's drift outside CloudFormation that a re-bootstrap won't restore.

**Lambda@Edge (Hosting outside `us-east-1`).** CDK hoists edge functions into a `us-east-1` stack; with `defaults.app` set, AWS Blocks names it `<id>-edge`, so the guard and the execution policy treat it as the app's own. Bootstrap the app in `us-east-1` too (same qualifier, same execution policy) and attach the guard there.

#### The pipeline

Synthesize with `strict: true` (in the project template, see below), which fails synth on any violation in the IAM report, and confirm that every report names the id the platform registered for this app:

```bash
APP_ID=appa NODE_OPTIONS="--conditions=cdk" npx cdk synth --quiet   # fails on any violation (strict: true)
jq -e -s --arg id "$APP_ID" 'length > 0 and all(.[]; .app.id == $id and (.violations | length) == 0)' cdk.out/*.blocks-iam.json
```

`APP_ID` comes from the platform's own registry, not from the app's repository. Fail the pipeline on a non-zero exit from either command.

This is feedback, not the guarantee. Synth runs the app's own code, so a determined app can write any report it likes. What keeps apps apart is IAM: the boundary on every role, the execution role that only creates bounded roles tagged as the app, and the deploy guard. Run synth in a job that has no AWS credentials and no `id-token` permission, and deploy the synthesized assembly (`cdk deploy --app cdk.out`) from a job that has the credentials and doesn't run the app's code.

**Limits.**

- **It isolates apps from each other, not handlers inside one app.** Every handler in an app still runs as the same role, under the same boundary.
- **Allow-list coverage.** A service the boundary has no statement for is denied at runtime (`AccessDenied`). Add statements for any service your apps use beyond AWS Blocks' own. A few statements are scoped by resource tag rather than name (Cognito, Step Functions, Secrets Manager, KMS and others); check them on a deployed app.
- **Exceptions — cross-app reach the boundary still allows.**
  - `ses:SendEmail` / `SendRawEmail` / `SendBulkEmail` on `*`: App A can send as an identity App B verified. Scope SES by identity if your apps send email.
  - `ec2:DeleteNetworkInterface` on `*` (for VPC Lambdas): App A could delete another app's network interfaces.
  - AgentCore runtimes log to AWS-named log groups, which the boundary allows for writing only.
  - The CloudFront configuration types the execution policy can't scope, if you grant them.
- **CDK's cross-region references.** Hosting's `us-east-1` stacks are wired to the app's stack by CDK's cross-region export writer, which is granted `/cdk/exports/*`. The IAM report exempts exactly that grant (its actions on that resource): it's CDK-internal, and the boundary caps it to the exports of the app's own stacks (`/cdk/exports/<id>…`). Likewise, CDK's Lambda@Edge ARN reader's read of `/cdk/EdgeFunctionArn/*` is capped by the boundary to the app's own stack path.
- **Account quotas are shared.** Each app adds roles and a bootstrap stack; at thousands of apps, spread them across several accounts.
- **One account per app remains the stronger model.** A boundary only enforces what its statements cover.

#### The app's side: what to put in your project template

A platform team gives every app the same starting point, so the identity, the boundary and `strict` are there before anyone writes code. Put these files in the platform's own project template (for example a copy of an AWS Blocks starter such as `npm create @aws-blocks/blocks-app@latest my-app -- --template api-only`). `APP_ID` is the app's id from the platform's registry; the pipeline sets it, and a developer exports it for a sandbox (`APP_ID=<id> npm run sandbox`).

**`aws-blocks/index.cdk.ts`.** The app id is the bootstrap qualifier and the stack name, and `defaults.app` sets the identity. `defaults.app` validates the id at synth (pattern and reserved ids, with the reason), so the entry only has to check that `APP_ID` is set:

```typescript
import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set by the platform's pipeline from its own registry, never chosen by this repository.
const appId = process.env.APP_ID;
if (!appId) {
  throw new Error("APP_ID is not set. The platform's pipeline sets it; for a sandbox, export APP_ID=<your app id> first.");
}

// The app's own CDK bootstrap: `cdk bootstrap --qualifier <id>`.
const app = new cdk.App({ context: { '@aws-cdk/core:bootstrapQualifier': appId } });

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

// Every derived name starts with the stack name, so name it `<id>`, or `<id>-…` for a sandbox.
const stackName = sandboxMode ? `${appId}-${getStackName({ sandbox: true, projectRoot })}` : appId;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...(sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production),
    app: { id: appId, strict: true },
    permissionsBoundary: process.env.APP_PERMISSIONS_BOUNDARY ?? 'apps-boundary',
  },
});
```

A sandbox stack is named `<id>-<stackId>-<sandbox id>` (`getStackName({ sandbox: true })` returns `<stackId>-<sandbox id>`). `APP_PERMISSIONS_BOUNDARY` is for an app that needs its own boundary (`apps-boundary-<id>`, see Limits).

**`cdk.json`.** AWS Blocks' `npm run deploy` and `npm run sandbox` check the bootstrap with the qualifier in `cdk.json`, and the CDK CLI looks up the app's own toolkit stack. Add both to the starter's `cdk.json`, with the app's id:

```json
{
  "context": {
    "@aws-cdk/core:bootstrapQualifier": "<id>"
  },
  "toolkitStackName": "CDKToolkit-<id>"
}
```

**`.blocks/config.json`.** Set `stackId` to the app id, so Hosting's `secret()` and `config()` values are named `blocks/<id>/secrets/…` and `/blocks/<id>/config/…`, the app's own:

```json
{ "stackId": "<id>" }
```

**`package.json`.** A script that runs the pipeline's synth locally (`APP_ID` must be set). With `strict: true`, it fails on any violation in the IAM report:

```json
{
  "scripts": {
    "check:iam": "cdk synth --quiet"
  }
}
```

**`AGENTS.md`.** Rules for the coding agents that write the app:

```markdown
## Platform rules (this app runs on a shared app platform)

This app shares one AWS account with other apps. The platform rejects a deploy that breaks these rules:

- Build with Building Blocks only. Don't write IAM policies, roles or grants (`addToPrincipalPolicy`, `grant*` on raw CDK constructs), and don't attach managed policies.
- Never reference another app's resources. Don't call `fromExisting(...)` with a name or ARN that isn't this app's, and don't name resources yourself: the Building Blocks name them, and every name starts with this app's id.
- Don't edit the platform's files: `aws-blocks/index.cdk.ts`, `cdk.json`, `.blocks/config.json` and the deploy workflow. They set this app's identity and permissions boundary. Ask a platform reviewer instead.
- Check before you push: `APP_ID=<this app's id> npm run check:iam` runs the pipeline's synth, which fails on any IAM violation because `defaults.app.strict` is on. The report is `cdk.out/<stack>.blocks-iam.json`; its `violations` say what to fix.
```

**The app's own code.** The boundary keeps apps apart, not users inside one app: gate every API method with `await auth.requireAuth(context)`, and keep each user's files under their own prefix (``files.putUrl(`${user.userId}/${path}`, …)``).

#### Adopting `defaults.app` in an existing app

An app deployed before it set `defaults.app` has resources with no `app` tag. The execution policy manages resources of the tag-scoped types — Secrets Manager secrets, KMS keys, Cognito user pools, Step Functions state machines, API Gateway APIs, CloudFront distributions and KeyValueStores, DSQL clusters, Bedrock knowledge bases and EC2 VPC resources — only once they're tagged `app=<id>`, including the update that would add the tag, so the first deploy under it fails on them (`AccessDenied`, e.g. on `kms:DescribeKey`). That's on purpose: a policy that let a deploy tag an untagged resource would let any app claim one. The tag-scoped types are the ones marked "tag" in the [per-service rules](#the-per-app-execution-policy). Adopt in this order:

1. **The stack names must already start with the id** (`<id>` or `<id>-…`): a stack can't be renamed, so another name means new stacks (and moving the data), not adoption.
2. **An admin, not the app's pipeline, tags the app's existing resources `app=<id>` once**, before the first deploy under the execution policy. Do it for each of the app's stacks, in its region and in `us-east-1` (Hosting's `<id>-CfMonitoring-…` stack, and CloudFront's global resources, which the Tagging API lists in `us-east-1`). CloudFormation tags what it creates `aws:cloudformation:stack-name`, so the Resource Groups Tagging API can find and tag them (`tag-resources` takes up to 20 ARNs at a time):

   ```bash
   STACK=<stack name>; REGION=<region>; APP=<id>
   aws resourcegroupstaggingapi get-resources --region "$REGION" \
     --tag-filters "Key=aws:cloudformation:stack-name,Values=$STACK" \
     --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' |
     xargs -n 20 aws resourcegroupstaggingapi tag-resources --region "$REGION" --tags "app=$APP" --resource-arn-list
   ```

   Compare with `aws cloudformation list-stack-resources --stack-name "$STACK" --region "$REGION"`, which lists every resource in the stack, and tag any tag-scoped one the first command missed with its service's own tag command. Tag IAM roles with `aws iam tag-role --role-name <role> --tags Key=app,Value=<id>` (the execution policy manages the app's roles by their `<id>-…` name, and the deploy adds the tag, so this is optional).
3. **Set `stackId` in `.blocks/config.json` to the id**, if it isn't already. Hosting's `secret()` and `config()` values move to `blocks/<id>/secrets/…` and `/blocks/<id>/config/…`, so set each value again (`npm run secret -- set …`, `npm run config -- set …`) before deploying; the old ones stay where they were until you delete them. If `index.cdk.ts` builds the stack name from `stackId` (`getStackName()`, `<stackId>-prod`), changing it renames the stack: see step 1.
4. **Expect replacements on the first deploy.** AWS Blocks renames the CloudFront Functions and KeyValueStores it creates to `<id>-<region>-…`, and a new name replaces the resource. CloudFormation then tries to delete the old ones, and the old Functions fail to delete (`DELETE_FAILED`, skipped; the stack still reaches `UPDATE_COMPLETE`), because their names (`<region>…`) are outside the app's prefix — and so can the old KeyValueStores still associated with them. An admin deletes them once: `aws cloudfront delete-function --name <name> --if-match <ETag from describe-function>`, then `aws cloudfront delete-key-value-store --name <name> --if-match <ETag from describe-key-value-store>`. Hosting's Lambda@Edge stack (Hosting outside `us-east-1`) becomes a new stack, `<id>-edge` (CDK named it `edge-lambda-stack-<hash>`); the app's deploy guard can't touch the old one, so an admin deletes it once the distribution no longer uses its functions (Lambda@Edge replicas can take hours to release).
