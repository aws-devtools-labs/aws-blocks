# @aws-blocks/core

Core primitives for building full-stack applications with the AWS Blocks.

## Key Exports

### Scope

Defines the boundary for your backend resources. The `Scope` class docstring serves as an index to all available Building Blocks.

```typescript
import { Scope } from '@aws-blocks/core';

const scope = new Scope('my-app');
```

Pass `compute` to place everything created under a scope, and in its child
scopes, on one `Compute` (`new Scope('reports', { parent: scope, compute })`);
see the `@aws-blocks/bb-compute` README for what follows it.

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
- Errors come back as HTTP `200` with an `error` object in the body (per JSON-RPC), not as a non-2xx status — unless the namespace opts in to `httpErrorStatus` (below).

To let status-code-only tooling (API Gateway and CloudFront metrics, access logs, WAF rate rules, a 4xx alarm) see rejected calls, create the namespace with `httpErrorStatus: true`. A call that throws an `ApiError` with a `4xx` status is then answered with that HTTP status; the body is the same JSON-RPC error, and the typed client decodes it the same way, so `isBlocksError()` is unaffected. `5xx` and other failures stay HTTP `200`. It applies locally and on AWS:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getNote() {
    const user = await auth.requireAuth(context); // signed out → HTTP 401
    return notes.get(user.userId);
  },
}), { httpErrorStatus: true });
```

Turn it on only when every client of the namespace reads the body of a non-2xx response (a hand-written `fetch` that throws on `!response.ok` would not). Two more things to check:

- **Hosting error pages.** CloudFront custom error responses apply to the whole distribution, `/aws-blocks/*` included. When it maps 403 or 404 to a page — `errorPages.notFound`, a static build's own `404.html`, or the default not-found page of a static multi-page site — a 403 / 404 from such a namespace reaches the browser as that HTML page and the typed client cannot read it. CloudFront cannot scope error responses away from `/aws-blocks/*`, so `Hosting` fails synth for that combination (`HttpErrorStatusErrorPagesError`): remove the 4xx error pages, or leave `httpErrorStatus` off for the namespace. 401, 409 and 429 are not mapped.
- **Dart clients with bearer tokens.** With an `authProvider`, the Dart client treats any HTTP 401 as an expired token: it refreshes and runs the method once more, so a method that throws 401 after a side effect runs twice. Put the guard first — `requireAuth()` as the first statement, or `auth.protect`, which runs it before any of the method's code — and keep any method that can still fail with 401 later idempotent. The Swift and Kotlin clients decode the error the same way on any status, and do not retry.

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
- **Container computes.** A namespace on a `container` compute is integrated through a VPC link to an internal Application Load Balancer that the compute provisions in the app's VPC; the load balancer forwards each namespace's path to its container's tasks. Namespaces without a compute, `RawRoute`s and the auth routes stay on the default compute. On the `cloudfront` tier, CloudFront reaches a container namespace straight from the distribution instead (see [API front door](#api-front-door)), so the gateway's throttling, access logs and limits don't apply to it.
- **Throttling** is on by default from `defaults.throttling` (sandbox 200 requests/s with a 400 burst, production 1000/2000). **Structured JSON access logs** are opt-in via `defaults.accessLogging`; each entry records the matched route (`resourcePath`) — the route template, so requests served by the catch-all resources (every namespace on the default compute, every `RawRoute`) log as their `{proxy+}` resource rather than the path called.
- **Limits:** the gateway times out a request after 29 seconds and caps payloads at 10 MB. Run longer work in an `AsyncJob`.
- **WAF** is off by default. Turn it on with `apiWaf` on `BlocksStack` / `BlocksBackend`: `apiWaf: { enabled: true, rateLimit? }` creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit (default 1000 requests per 5 minutes). The Common rule set's body rules (`SizeRestrictions_BODY`, `CrossSiteScripting_BODY`, `GenericLFI_BODY`, `GenericRFI_BODY`) only count, so normal RPC payloads, including user-written HTML or Markdown, pass. `apiWaf: { webAclArn }` attaches a web ACL you already have instead; its scope and region are checked at synth. It's attached as-is, so behind a `Hosting` door its IP rate rules count CloudFront edge or proxy IPs for browser traffic. The web ACL goes on whichever front door clients use:
  - `apiFrontDoor: 'apigateway'` — a `REGIONAL` web ACL on the gateway stage, in any region. If a `Hosting` door also forwards browser traffic to it, the rate rule adjusts so browser users aren't counted as one client: a CloudFront `Hosting` that claims the API sends a marker header the rate rule exempts, and behind any other door (ALB, API Gateway, your own, or a CloudFront edge over a router) the rate rule is left off and synth warns (`blocks:api-waf:no-rate-limit-behind-door`), so rate-limit on the door's own WAF. In both cases browser requests arriving through Hosting aren't rate-limited by `apiWaf`; turn on the door's own WAF (`frontDoor: { features: { waf: { enabled: true } } }`) to rate-limit them.
  - `apiFrontDoor: 'cloudfront'` — a `CLOUDFRONT` web ACL on the managed distribution, which also covers the container namespaces it routes straight to their load balancer. AWS only creates these in us-east-1, so in other regions pass `webAclArn` of one created there (`enabled: true` fails synth). Without one, synth warns that those container namespaces have no rate limit (`blocks:api:direct-routes-without-waf`).
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

where `{namespace}` is the backend export name (`export const api = …` → `api`). The bare `POST /aws-blocks/api` form still works for back-compat; it runs on the default compute, and with `defaults.strictNamespacePlacement` it refuses a namespace placed on another compute. Either way the request body's `method` (`"api.greet"`) names the namespace that runs; a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the call fails with a JSON-RPC `-32600` Invalid Request. Internally the shared gateway routes each namespace's path to the compute that hosts it; by default every namespace runs on the single default compute, so every path lands on the same function. Pass `{ compute }` as the fourth `ApiNamespace` argument to run a namespace on its own `Compute`; the API namespaces section of the `@aws-blocks/bb-compute` README lists what that changes (and what it doesn't), including which callers reach the namespace's compute. With `'cloudfront'`, the path of a namespace on a `container` compute has a CloudFront behavior of its own — on the managed distribution, or on `Hosting`'s default CloudFront door when it fronts the API — that goes straight to the container's load balancer (calls can run up to 60 seconds); every other path reaches the gateway. The `stacked` door's edge is not one of them: it sends `/aws-blocks/*`, container namespaces included, through its ALB router to the gateway, so those calls keep the gateway's 29-second limit (the load balancer still gets its CloudFront prefix-list rule and lookup, unused). A container namespace whose VPC has no public subnets (an isolated VPC) also stays on the gateway: a CloudFront VPC origin needs an internet gateway, and synth warns (`blocks:api:direct-routes-without-public-subnets`). The check reads the VPC's public subnets, so for an imported VPC (`Vpc.fromVpcAttributes`) list its `publicSubnetIds`. On the `apigateway` tier, a CloudFront `Hosting` sends container namespaces to the gateway like every other path.

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

The client decodes that back into an `ApiError` with the same `status`, `name` and `retriable`, which is why the same `isBlocksError(e, ...)` check works on both sides. Reserved JSON-RPC codes (`-32600`, `-32700`, …) decode to `status: 500`. A response that is not a JSON-RPC envelope, such as a gateway's own `429 {"message":"Too Many Requests"}` or an HTML error page, also rejects with an `ApiError`: `status` is the HTTP status (`502` if that status was 2xx) and `message` is the body's `message` when present, else `HTTP <status>`.

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

#### Monitoring failed RPC calls

A failed RPC call (a method that throws, or a call to an unknown API namespace or method) reaches the client as a JSON-RPC error inside an HTTP 200 response, and the Lambda invocation itself succeeds. So Lambda's `Errors` metric never counts it. Instead, on Lambda each failed call writes one log line in CloudWatch embedded metric format, which CloudWatch turns into a metric with no SDK call and no extra IAM permission:

| | |
|---|---|
| Namespace | `AWSBlocks` |
| Metric | `RpcErrors` (Count) |
| Dimensions | `FunctionName`, `StatusClass` (`4xx` for a client error such as an `ApiError` with status 403, `5xx` for anything else, including an unexpected error and the handler's 504 timeout) |
| Also in the log line | `Status`, `ApiNamespace` and `Method`, searchable with CloudWatch Logs Insights |

Alarm on `StatusClass = 5xx` to catch server failures; `4xx` counts include expected rejections such as an unauthenticated call. The error message is never written to the metric line.

API namespaces on a `container` compute don't emit this metric yet: only Lambda functions write it.

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
| `url` | Absolute `URL` of the request. Use `url.searchParams` for the query string. `url.pathname` is the route path, the same under `npm run dev` and deployed: it never includes the API Gateway stage (`/prod`). Behind a front door such as `Hosting`, `url.origin` is the API Gateway host the backend received, not the browser's, so don't build public links from it. |
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

To sub-route under a wildcard, match on `params['*']` (or `url.pathname`, which is the same path in every environment) rather than on a full URL.

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

`buildCommand` runs during synth, with `BLOCKS_API_URL` set to the backend the frontend talks to, and then the framework adapter runs its own build (OpenNext, Nitro, Astro, SvelteKit). Two synths skip both:

- **Destroy.** `npm run destroy` and `npm run sandbox:destroy` don't deploy the frontend, so `Hosting` reuses the build output already on disk instead of building. It builds only when there is no output, for example on a fresh clone. Each framework adapter checks the output it deploys: a Next.js destroy reuses the `.open-next/` output of an earlier deploy, and with only `.next/` (after a plain `next build`) OpenNext still builds, because the synth needs its output. An exported `BLOCKS_SKIP_FRONTEND_BUILD=1` doesn't apply to a destroy.
- **A deploy you ask to run on the existing build.** Set `BLOCKS_SKIP_FRONTEND_BUILD=1`, for example `BLOCKS_SKIP_FRONTEND_BUILD=1 npm run deploy`, to deploy what is already in the build output directory. Nothing is built, and a missing build output (the output directory, or the output the framework adapter deploys, such as Next.js's `.open-next/`) fails the synth with a message naming the variable. The build bakes in `BLOCKS_API_URL`, so only reuse a build made for the same backend; a deploy never reuses one on its own.

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


#### Preview mode and `HostingPresets`

`HostingPresets` are the hosting counterpart of `BlocksPresets`: plain bundles of `Hosting` props. `HostingPresets.preview` is a fast, cheap, disposable shape for ephemeral environments (pull-request previews, per-branch sandboxes); `HostingPresets.production` is the full shape (it sets nothing). Spread one first and override settings after it:

```typescript
import { Hosting, HostingPresets } from '@aws-blocks/core/cdk';

new Hosting(stack, 'Web', {
  ...(process.env.DEPLOY_ENV === 'preview' ? HostingPresets.preview : HostingPresets.production),
  root: join(__dirname, '..'),
  api: blocksStack,
});

// a preview that keeps image optimization
new Hosting(stack, 'Web', { ...HostingPresets.preview, imageOptimization: true, root, api: blocksStack });
```

`HostingPresets.preview` sets:

| Prop | Value | Effect |
|---|---|---|
| `frontDoor` | `{ kind: 'apiGateway' }` | The API Gateway HTTP API door: no CloudFront; buffered server responses, about 6 MB each |
| `imageOptimization` | `false` | No image function; the image endpoints serve the source image (a remote one is redirected only when its host is in the app's image allowlist, else 404) |
| `incrementalRegeneration` | `false` | Next.js builds without the tag cache and revalidation queue; prerendered pages come from the build's snapshot |
| `edgeRoutes` | `'regional'` | Next.js `runtime: 'edge'` routes run as regional Lambda functions, not Lambda@Edge |
| `buildId` | `'fixed'` | A build id keyed on the build's content: an unchanged build keeps it, so a re-deploy skips the asset upload and can hotswap; a changed build gets a new prefix (deleted files stop being served). The door's asset proxy is created alongside the asset uploads, so there is no atomic switch-over |

Each prop also works on its own. `incrementalRegeneration: false` works behind every door. `imageOptimization: false` and `edgeRoutes: 'regional'` need the API Gateway HTTP API door (where `edgeRoutes` defaults to `'regional'`, since that door can't invoke Lambda@Edge), and `buildId: 'fixed'` needs a door without an edge cache (not CloudFront or the stacked door). Any other combination fails synth with `UnsupportedHostingSettingError`.

From the command line, `npm run sandbox:preview` (in a `create-blocks-app` app) deploys a preview sandbox: the disposable sandbox backend plus the app with `HostingPresets.preview`, and prints its URL. It runs `startSandbox({ preview: true, deployOnly: true })`, which sets `--context previewMode=true` next to `sandboxMode=true` (the key is exported as `PREVIEW_MODE_CONTEXT` from `@aws-blocks/core/scripts`). On a re-deploy, a backend-only change is hotswapped; a changed frontend build or an infrastructure change does a full deploy. The app decides what the signal does; the templates add `Hosting` for it, so a plain `npm run sandbox` stays backend-only. `sandbox`, `sandbox:deploy` and `sandbox:preview` deploy one stack: a plain sandbox deploy removes the preview (it warns first), and running `sandbox:preview` again adds it back at a new URL:

```typescript
const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const previewMode = app.node.tryGetContext('previewMode') === 'true';

if (!sandboxMode || previewMode) {
  new Hosting(blocksStack, 'Hosting', {
    ...(previewMode ? HostingPresets.preview : HostingPresets.production),
    root: join(__dirname, '..'),
    api: blocksStack,
  });
}
```

Tear a preview sandbox down with `npm run sandbox:destroy`.


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

The dev server also checks the `Host` header of every request and answers `403 Forbidden` unless it names `localhost`, `127.0.0.1`, `[::1]` (with any port) or the host you configured. This blocks DNS rebinding, where a page on another site re-points its own DNS name at `127.0.0.1` and then calls your local API as if it were same-origin. The local `/aws-blocks/settings` shortcut opens `.bb-data/settings.json` in your editor only for a request you made yourself (typed into the address bar or followed from your app, including a frontend served on another `localhost` port); a request another site triggers gets `403`.

You can also set the host with `npm run dev -- --host <host>` or `"host"` in `package.json#blocks.dev`; the `cdk-blocks` CLI then also exports it to the dev server as `BLOCKS_DEV_HOST`. The local realtime WebSocket (`/realtime`) accepts upgrades only from loopback origins, or from the host in `BLOCKS_DEV_HOST`. Passing `host` to `startDevServer({ host })` when you call it yourself changes only the interface it binds; set `BLOCKS_DEV_HOST` too to opt `/realtime` in:

- With a **wildcard** (`BLOCKS_DEV_HOST=0.0.0.0`), open the app **by IP address** (e.g. `http://192.168.1.10:3000`). Requests and same-origin pages reached by IP are accepted; DNS names are not (the dev server answers them `403`), because a same-origin check against a name can be defeated by DNS rebinding.
- To open it by **hostname** (e.g. `http://mybox.example.com:3000`), set `BLOCKS_DEV_HOST=mybox.example.com` instead.
- Behind a **reverse proxy or a port-forwarding tunnel** that passes its own public hostname in `Host` (a cloud-IDE forwarded-port URL, or nginx with `proxy_set_header Host $host`), configure the proxy to rewrite `Host` to `localhost:<port>`. `BLOCKS_DEV_HOST` is also the address the dev server binds, so setting it to a name that only exists in front of the proxy makes the dev server fail to start.

Only server-side `Realtime.publish()` can publish. Clients can subscribe, but not publish, exactly as in a deployed app.

## Script output (`BLOCKS_LOG_LEVEL`)

The lifecycle scripts in `@aws-blocks/core/scripts` (`deploy`, `destroy`, `startSandbox`, `destroySandbox`, `startDevServer`, which the generated `npm run deploy` / `sandbox` / `sandbox:destroy` / `destroy` / `dev` scripts call) read the `BLOCKS_LOG_LEVEL` environment variable to decide how much to print:

| `BLOCKS_LOG_LEVEL` | What prints |
|---|---|
| unset (or any other value) | Everything, exactly as before this variable existed. |
| `quiet` | Errors and final results only. CDK output is hidden while it runs. |
| `normal` | Short progress steps and results. CDK output is condensed into a few lines (`Synthesizing app...`, a resource count); failure and rollback lines still print as they happen. |
| `verbose` | The same lines as unset: every progress step plus the raw CDK output (the dev server leaves out RPC error stack traces, see below). |
| `debug` | `verbose` plus stack traces for errors the scripts catch and report as warnings. |

```bash
BLOCKS_LOG_LEVEL=normal npm run deploy
```

No level hides the lines other tools read: the deployment-target summary, the `API URL` / `Frontend URL` lines, the early `🌐 Frontend deploying to:` line, the `BLOCKS_DEPLOYED …` line, and error messages.

At `quiet` and `normal` the scripts keep the last 500 lines of the hidden CDK output (`cdk synth`, `cdk deploy`, `cdk destroy`, `cdk watch`). If the deploy or destroy fails, they print those lines to stderr under a `──── cdk deploy output (…) ────` header before the error, so you don't need to run it again to see why it failed. `cdk watch` prints them when a watch deploy fails or `cdk watch` exits with an error.

In the dev server, `quiet` and `normal` hide the per-call `[rpc-in]` / `[rpc-call]` / `[rpc-ok]` lines but keep the `[rpc-err]` and `RawRoute Error:` lines (name, message and `cause`); the stack trace prints when `BLOCKS_LOG_LEVEL` is unset or `debug`. `BLOCKS_DEV_QUIET=1` still hides all of those lines at every level.

## CORS Configuration

By default, the Lambda handler does **not** set any `Access-Control-Allow-Origin` header. Allowed origins come from two places: the stack's `defaults.allowedOrigins` (plain origins or regex patterns; every Blocks compute receives them as the `CORS_ALLOWED_ORIGINS` environment variable) and, when you use `Hosting`, the distribution's own domain (registered automatically as `CORS_HOSTING_ORIGINS`).

### `allowedOrigins` entries

Each entry in `defaults.allowedOrigins` is one of:

- **A plain origin** — `scheme://host[:port]`, such as `'https://app.example.com'` or `'http://localhost:3000'`. It is matched exactly and case-insensitively; its dots are literal, so `https://appxexample.com` does not match. A trailing `/` is ignored. An `http`/`https` origin is compared in the form the browser sends: the default port is dropped (`'https://app.example.com:443'` matches `https://app.example.com`) and an internationalized host is converted to punycode (`'https://bücher.example'` matches `https://xn--bcher-kva.example`). User info (`user@`), a path (anything after the host and port other than a single trailing `/`), a query or a fragment is not part of an origin and is rejected, as is a host with characters other than letters, digits, `.` and `-` (or a bracketed IPv6 address).
- **A regex pattern** — any entry with regex syntax (`^`, `$`, `\`, `(`, `|`, `*`, ...). It is anchored as `^(?:<entry>)$` and matched case-sensitively. Escape every dot (`'https://app\\.example\\.com'`) unless it is followed by a quantifier, as in `'.*'`, and make sure the entry compiles on its own. To allow any subdomain, use a pattern such as `'https://[a-z0-9-]+\\.example\\.com'`; glob wildcards such as `'https://*.example.com'` are not supported. Brace quantifiers are limited to `{n}`: `{n,}` and `{n,m}` contain a comma, and entries are comma-joined into `CORS_ALLOWED_ORIGINS`. A group repeated with `*`, `+` or `{n}` that itself contains a repeating quantifier or an alternation (such as `'(a+)+'`, `'([a-z]+\\.)*'` or `'(a|b)+'`) is not supported, because such patterns can make matching very slow; this check does not rule out every slow pattern. To allow subdomains at any depth, use `'https://[a-z0-9.-]+\\.example\\.com'` instead of `'https://([a-z0-9-]+\\.)*example\\.com'`.

`BlocksStack.create()` and `BlocksBackend.create()` reject an invalid entry (a plain origin that is not a valid origin; a regex that is a glob, does not compile on its own, has a nested quantifier or an alternation inside a repeated group, or has an unescaped `.`), so `cdk synth` fails with a message naming the entry. If one still reaches the runtime, it is ignored and logged.

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
  allowedOrigins: [...BlocksPresets.sandbox.allowedOrigins, 'https://preview.myapp.com'],
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
    allowedOrigins: ['https://myapp.com', 'https://staging.myapp.com'],
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
| 4. A CloudFormation execution policy, shared by every app, so each app's execution role only creates bounded roles tagged as the app | The platform | [The shared execution policy](#the-shared-execution-policy) |
| 5. A deploy guard, shared by every app, that keeps each app's deploy role on its own stacks | The platform | [The deploy guard](#the-deploy-guard) |
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

  Synth (`defaults.app`) rejects them, saying why. However the platform hands out ids, it should reject them too, before an app gets one.
- **Names.** Every Building Block derives its resource names (tables, queues, buckets, parameters, schedules, user pools) from its `fullId`, which starts with the stack's id, and CloudFormation-generated names (functions, roles, topics, alarms, managed policies) start with the stack name. So with the stack named `<id>` or `<id>-…`, every name starts with `<id>-`. Developers don't name anything themselves. AWS Blocks also names the Lambda layers (`<id>-<logical id>`) and the CloudFront Functions and KeyValueStores (`<id>-<region>-…`) it creates (CDK's default names don't put a `-` after the id), unless the app chose a name itself.
- **Hosting `secret()` and `config()`.** Their values are named `blocks/<stackId>/secrets/…` (Secrets Manager) and `/blocks/<stackId>/config/…` (SSM (AWS Systems Manager)), where `stackId` comes from `.blocks/config.json`. Under `defaults.app`, set `stackId` to the app id: the boundary allows `blocks/<id>/…` by name, so the values `npm run secret` / `npm run config` create untagged still work, and the IAM report treats any other `blocks/…` name as outside the app, with a hint to fix `stackId`.
- **Tags.** `app=<id>` goes on every resource CloudFormation creates for the app and every IAM role AWS Blocks creates, including the CDK custom-resource provider roles that `Tags.of()` doesn't reach, at a priority above the default `Tags.of(...).add()`. It also goes on `Hosting` and on the separate stacks Hosting adds (the `us-east-1` CloudFront alarm stack `<id>-CfMonitoring-…` and the Lambda@Edge stack `<id>-edge`), as a stack tag too, which CloudFormation propagates to what a tag aspect can't reach. An app can still raise its own priority or remove the tag; the execution role (part 4) rejects any role not tagged `<id>`. SecureString parameters that AWS Blocks' secret initializer creates at deploy time carry only the `aws-blocks-stack` tag; SSM is scoped by name, so that's no gap.
- **The boundary** goes on every role AWS Blocks creates, including the CDK helper roles and the roles CDK adds while preparing the app, which CDK's own `@aws-cdk/core:permissionsBoundary` context misses.
- **The IAM report** (`cdk.out/<stack>.blocks-iam.json`) gains an `app` section and a `violations` list: a role without the boundary or the app tag; a grant on a name outside the app's prefix (for example `fromExisting` on another app's parameter); a wildcard grant on a data service (SSM, DynamoDB, SQS (Simple Queue Service), S3, Secrets Manager, Lambda, CloudWatch Logs, Step Functions, Cognito, EventBridge and EventBridge Scheduler, KMS, API Gateway, SNS (Simple Notification Service), SES (Simple Email Service), RDS (Relational Database Service) and its Data API, Aurora DSQL, Bedrock, Bedrock AgentCore, S3 Vectors, ECS (Elastic Container Service) and CloudFront KeyValueStores), on `*` or on a resource name that starts with `*`, except three grants Building Blocks make: model invocation on AWS-owned Bedrock foundation models and system-defined inference profiles (no app's data), an Agent invoking AgentCore runtimes (the boundary caps it to runtimes tagged as the app), and SES sending (an exception listed under Limits); an "everything except" grant (`NotAction`, `NotResource`); a resource the check can't resolve (`Fn::Sub` on a parameter, `Fn::ImportValue`, a template parameter) — these fail closed; a resource policy that opens up another app's resource; a role that trusts anything but an AWS service; a broad AWS managed policy (`AdministratorAccess`, `*FullAccess`); the CDK asset bucket of another bootstrap; a grant on a literal API id, or an API Gateway stage, route or deployment attached to an API that isn't in the app's own template (`api-outside-app`); or a stack or block outside the prefix. With `strict: true`, synth fails on any violation. Without it, synth prints a one-line summary.

The report and `strict` are fast feedback for developers and their agents. They aren't the boundary: the app's own code runs at synth, so a determined app could get around them. The boundary is IAM, in parts 3–5.

**3–5. The platform's policies.** The platform writes these three policies and owns them: AWS Blocks never creates, changes or reads them. All three are **shared**: one of each per account, created once, never edited per app. Each one is keyed on the calling role's `app` tag (`${aws:PrincipalTag/app}`, which IAM resolves at request time), so the same document confines every app to its own names and tags:

| Policy | Attached to | What it does |
|---|---|---|
| `apps-boundary` | every role the app creates (`defaults.permissionsBoundary`) | caps what the app's code can do at runtime |
| `apps-exec` | each app's CDK bootstrap CloudFormation execution role | caps what the app's deploy can create and change |
| `apps-deploy-guard` | each app's CDK bootstrap deploy role | keeps the app's deploy on its own stacks and its own execution role |

Each app gets its own CDK bootstrap, tagged with its id, so the two roles in it carry the `app` tag the shared policies read:

```bash
cdk bootstrap aws://APPS_ACCOUNT/us-east-1 --qualifier appa --toolkit-stack-name CDKToolkit-appa --tags app=appa \
  --cloudformation-execution-policies arn:aws:iam::APPS_ACCOUNT:policy/apps-exec
```

CloudFormation propagates the stack tag to the bootstrap's roles. A role's `app` tag is what the policies trust, so no one may set it any other way: a session tag `app` would override it, and CDK's default bootstrap template allows `sts:TagSession` on its roles for principals in the account. Remove `sts:TagSession` from the deploy role's trust policy in the platform's bootstrap template (see [the deploy guard](#the-deploy-guard)).

The examples below use account `APPS_ACCOUNT` (replace it, and `aws` in the ARNs for another partition) and, where a command needs an id, app `appa`. Review them and test them on a deployed app in a sandbox account before relying on them.

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
      "Sid": "OwnVectorBuckets",
      "Effect": "Allow",
      "Action": "s3vectors:*",
      "Resource": [
        "arn:aws:s3vectors:*:*:bucket/${aws:PrincipalTag/app}-*",
        "arn:aws:s3vectors:*:*:bucket/${aws:PrincipalTag/app}-*/index/*"
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
    },
    {
      "Sid": "ApisAccountWide",
      "Effect": "Allow",
      "Action": [
        "execute-api:Invoke",
        "execute-api:ManageConnections"
      ],
      "Resource": "arn:aws:execute-api:*:*:*/*"
    }
  ]
}
```

What each group of statements is for:

- **By name prefix** (`OwnParameters` to `OwnVectorBuckets`): SSM parameters, DynamoDB tables, SQS queues, S3 (Amazon Simple Storage Service) buckets, Lambda functions, log groups (including `/aws/lambda/<id>-…` and a Database's `/aws/rds/cluster/<id>-…`), schedules, event rules and buses, RDS clusters and instances, and S3 Vectors buckets and the indexes in them, named under the app's prefix (`<id>-…`; parameters also `<id>` and `<id>/…`). AWS Blocks guarantees those names under `defaults.app`. `OwnStacksRead` lets a table's index manager read its own stack. `OwnParameters` also covers CDK's cross-region references for the app's own stacks (`/cdk/exports/<id>…`), the Lambda@Edge ARNs CDK publishes for Hosting (`/cdk/EdgeFunctionArn/<region>/<id>/…`) and Hosting's `config()` values (`/blocks/<id>/…`); `OwnHostingSecrets` covers Hosting's `secret()` values (`blocks/<id>/…`), which the CLI creates untagged.
- **The app's own CDK assets** (`ReadOwnCdkAssets`): read-only access to its own bootstrap's asset bucket (qualifier = app id), which `BucketDeployment` reads.
- **By the resource's `app` tag** (`OwnTaggedResources`): Secrets Manager, Step Functions, Cognito, KMS (Key Management Service), Bedrock, AgentCore, DSQL (Aurora DSQL) and CloudFront resources are named by id, not by a name the app controls, so they're matched by `aws:ResourceTag/app`. S3 Vectors is matched by name instead (`OwnVectorBuckets`): a new index carries the tag of the app that creates it, so a tag rule would let App A create an index in App B's vector bucket (see "Fence children by their parent" in [The shared execution policy](#the-shared-execution-policy)).
- **Exceptions with no app scope, each as narrow as the service allows:** `AgentCoreRuntimeLogsWriteOnly` (AgentCore runtimes log to AWS-named groups, write only); `AgentCoreDefaultDirectory` (workload access tokens from the account's `default` directory; the workload identity itself stays tag-scoped); `AwsOwnedModelsRead` (metadata of AWS-owned foundation models and system-defined inference profiles, not application inference profiles, which are tag-scoped); `ManagedKeysViaService` (AWS-managed keys, only through SSM, Secrets Manager, DynamoDB, S3 and SQS); and `ResourcelessActions` (actions that take only `*`: X-Ray, `PutMetricData`, `DescribeLogGroups`, VPC network interfaces, model invocation and listing, SES).
- **API calls, account-wide** (`ApisAccountWide`): `execute-api:Invoke` (calling an IAM-authorized API) and `execute-api:ManageConnections` (posting to and disconnecting WebSocket clients, which Realtime publish/subscribe and every Agent's streaming use). An API is named by its id, and these actions support no tag condition, so no statement can scope them to one app: runtime API calls are outside the isolation (see Limits, under [The pipeline](#the-pipeline)). Deploying APIs stays isolated: the execution policy creates and manages only API Gateway APIs tagged as the app.

It is about 4,900 characters, below IAM's 6,144-character limit for a managed policy.

#### The shared execution policy

Every app's CDK bootstrap execution role (the role CloudFormation deploys the app's stacks as) gets the shared `apps-exec` instead of `AdministratorAccess`: the `--cloudformation-execution-policies` in the bootstrap command above. Set the same `@aws-cdk/core:bootstrapQualifier` and `toolkitStackName` in the app's `cdk.json`. In the policy, `${aws:PrincipalTag/app}` is the execution role's own `app` tag, which its bootstrap set. The policy has two parts.

**The role fence.** It can only create roles that carry the boundary, are named `<id>-…` and are tagged `app=<id>`; it can never remove the boundary, edit the shared policies, re-tag a role to another app or untag it, or attach a broad AWS managed policy; and it reads only its own bootstrap's version parameter and asset bucket:

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
      "Resource": "arn:aws:iam::APPS_ACCOUNT:role/${aws:PrincipalTag/app}-*",
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
      "Resource": "arn:aws:iam::APPS_ACCOUNT:role/${aws:PrincipalTag/app}-*"
    },
    {
      "Sid": "RequireThisAppsTag",
      "Effect": "Deny",
      "Action": "iam:CreateRole",
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
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
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
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
      "Sid": "NoEditingTheSharedPolicies",
      "Effect": "Deny",
      "Action": [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion"
      ],
      "Resource": [
        "arn:aws:iam::APPS_ACCOUNT:policy/apps-boundary*",
        "arn:aws:iam::APPS_ACCOUNT:policy/apps-exec*",
        "arn:aws:iam::APPS_ACCOUNT:policy/apps-deploy-guard"
      ]
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
      "Resource": "arn:aws:ssm:*:APPS_ACCOUNT:parameter/cdk-bootstrap/${aws:PrincipalTag/app}/*"
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
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-APPS_ACCOUNT-*",
        "arn:aws:s3:::cdk-${aws:PrincipalTag/app}-assets-APPS_ACCOUNT-*/*"
      ]
    }
  ]
}
```

`RoleLifecycle` has no boundary condition, so `iam:PassRole` and `iam:DeleteRole` work on the app's existing roles; every role it can create already carries the boundary. `NoRetaggingToAnotherApp` denies only a tag write that sets `app`, so other tag updates still work.

**Per-service rules.** Add statements only for the resource types the platform's apps use (`jq -rs '[.[].Resources[]?.Type] | unique[]' cdk.out/*.template.json` for each app), each scoped to the app's names or its `app` tag. `<id>` below stands for `${aws:PrincipalTag/app}` in the policy, and `ACCOUNT` is the account id:

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
| `AWS::CloudWatch::Dashboard` | `PutDashboard`, `GetDashboard`, `DeleteDashboards`, `TagResource`, `UntagResource`, `ListTagsForResource` on `dashboard/<id>-*`. Without the tag actions the deploy still succeeds: CloudFormation retries the create without tags (its events say "Retrying request without including tags") and the dashboard has no `app` tag |
| `AWS::IAM::ManagedPolicy` (AWS Blocks' `BlocksRoleOverflowPolicy*`) | the policy and policy-version actions on `arn:aws:iam::ACCOUNT:policy/<id>-*` (attachable only to the app's roles, through the fence) |
| `AWS::ResourceGroups::Group` | `resource-groups:*` on `group/<id>-*`; `cloudformation:DescribeStacks`, `ListStackResources`, `tag:GetResources` on `*` |
| `AWS::S3Vectors::VectorBucket`, `Index`, `VectorBucketPolicy` | by name, not tag: `s3vectors:*` on `bucket/<id>-*` and `bucket/<id>-*/index/*`, and a deny on every other bucket (`VectorBuckets` and `VectorBucketsOnlyOwn`, below) |
| `AWS::RDS::DBCluster`, `DBInstance`, `DBSubnetGroup`, `DBClusterParameterGroup`, `DBParameterGroup`, `OptionGroup` | `rds:*` on `cluster:`, `db:`, `subgrp:`, `cluster-pg:`, `pg:`, `og:`, `cluster-snapshot:` and `snapshot:<id>-*`; create and modify against RDS's `default…` parameter and option groups; `ec2:Describe*` on `*` |
| `AWS::CloudFront::Function` | `CreateFunction`, `DescribeFunction`, `GetFunction`, `UpdateFunction`, `PublishFunction`, `DeleteFunction`, `TestFunction` and `ListTagsForResource` on `arn:aws:cloudfront::ACCOUNT:function/<id>-*` |
| `AWS::SecretsManager::Secret`, `SecretTargetAttachment`, `ResourcePolicy`, `RotationSchedule` | tag (five statements, below), plus `secretsmanager:GetRandomPassword` on `*` (it reads nothing) |
| `AWS::ApiGateway::*` (APIs and their children) and `AWS::ApiGatewayV2::*` | tag (five statements, below), plus `apigateway:UpdateRestApiPolicy` on the `/restapis` collection |
| `AWS::Cognito::UserPool*` | tag |
| `AWS::KMS::Key`, `Alias` | tag; aliases by name, `alias/<id>-*` |
| `AWS::StepFunctions::StateMachine` | tag, on `stateMachine:*` and `execution:*` |
| `AWS::DSQL::Cluster` | tag |
| `AWS::ECS::Cluster`, `Service`, `TaskDefinition` | tag, on `cluster/*`, `service/*` and `task-definition/*` (task-definition families are CloudFormation-generated without a `-` after the id, so no name scopes them), plus the reads `DescribeTaskDefinition`, `ListTaskDefinitions`, `DescribeClusters`, `DescribeServices` and `DeregisterTaskDefinition` on `*` (an accepted exception: one app could deregister another app's task-definition revisions); and the cluster fence `EcsOnlyOwnClusters` (below) |
| `AWS::Bedrock::KnowledgeBase`, `DataSource` | tag (a data source is authorized against its knowledge base) |
| `AWS::EC2::VPC`, `Subnet`, `RouteTable`, `Route`, `SubnetRouteTableAssociation`, `SecurityGroup*`, `InternetGateway`, `VPCGatewayAttachment`, `NatGateway`, `EIP` | tag; creating a subnet, route table or security group, or attaching an internet gateway, also requires the VPC to be tagged `app=<id>`; security-group rules on `security-group-rule/*`; `ec2:Describe*` on `*` |
| `AWS::CloudFront::Distribution` | tag |
| `AWS::CloudFront::KeyValueStore` | tag (the create and manage statements; the denies on `cloudfront:*` come with the distribution's) |
| `AWS::CloudFront::OriginAccessControl`, `CachePolicy`, `OriginRequestPolicy`, `ResponseHeadersPolicy` | **can't be scoped** (see below) |
| `AWS::BedrockAgentCore::Runtime` | **not scoped** (see below) |
| `AWS::IAM::Role`, `Policy`, `RolePolicy`, `AWS::CDK::Metadata`, custom resources, wait conditions | the role fence; nothing else needed |

**Tag-scoped services: five statements each.** A service whose resources are named by id can't be scoped by name, so it's scoped by the `app` tag, and a request tag alone never grants access to an existing resource: **Create** only top-level resources, only tagged `app=<id>`; **Manage** only resources (and their children, which are authorized against their parent's tag) already tagged `app=<id>`, tag writes included, so an untagged resource can't be claimed; deny anything on a resource tagged as **another app** (`NotAnotherApps`); and deny any tag write that sets `app` to another value (`NoRetagging`) or removes it (`NoUntagging`). For API Gateway (REST, HTTP and WebSocket APIs), a tag is written with `apigateway:PUT` and removed with `apigateway:DELETE` on `/tags/<resource ARN>`, so those are the actions the tag statements name. One more action is needed: creating an API Gateway v2 stage (a WebSocket API's, which Realtime and every Agent's streaming use) with tags is authorized as `apigateway:TagResource` on `arn:aws:apigateway:<region>::/apis/<api id>/stages`, so `ApisCreate` allows it with the request tag and `ApisNoRetagging` denies it for another app's tag. IAM Access Analyzer reports `apigateway:TagResource` as `INVALID_ACTION` and the Service Authorization Reference doesn't list it, but IAM evaluates exactly that action on this call; without it the stage fails with `not authorized to perform: apigateway:TagResource`, and IAM accepts the policy with it:

```json
[
  {
    "Sid": "ApisCreate",
    "Effect": "Allow",
    "Action": [
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:TagResource"
    ],
    "Resource": [
      "arn:aws:apigateway:*::/restapis",
      "arn:aws:apigateway:*::/apis",
      "arn:aws:apigateway:*::/apis/*/stages",
      "arn:aws:apigateway:*::/tags/*"
    ],
    "Condition": {
      "StringEquals": {
        "aws:RequestTag/app": "${aws:PrincipalTag/app}"
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
      "apigateway:UpdateRestApiPolicy"
    ],
    "Resource": [
      "arn:aws:apigateway:*::/restapis/*",
      "arn:aws:apigateway:*::/apis/*",
      "arn:aws:apigateway:*::/tags/*"
    ],
    "Condition": {
      "StringEquals": {
        "aws:ResourceTag/app": "${aws:PrincipalTag/app}"
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
        "aws:ResourceTag/app": "${aws:PrincipalTag/app}"
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
      "apigateway:PUT",
      "apigateway:TagResource"
    ],
    "Resource": "*",
    "Condition": {
      "StringNotEquals": {
        "aws:RequestTag/app": "${aws:PrincipalTag/app}"
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
    "Resource": "arn:aws:apigateway:*::/restapis"
  }
]
```

The other tag-scoped services follow the same pattern with their own actions: for example Secrets Manager creates with `secretsmanager:CreateSecret` on `*`, manages `secretsmanager:*` on `arn:aws:secretsmanager:*:ACCOUNT:secret:*`, and tags with `secretsmanager:TagResource` / `UntagResource`. An API's children (stages, deployments, routes, integrations) are authorized against their parent API's `app` tag, so `ApisManage` and `ApisNotAnotherApps` cover them too; the IAM report flags a stage, route or deployment attached to an API outside the app's own template (`api-outside-app`). This scopes deploying APIs only: calling them at runtime is outside the isolation (see Limits).

**Fence children by their parent.** For a resource created inside a parent (ECS services and tasks in a cluster, vector indexes in a vector bucket, Cognito app clients and groups in a user pool, data sources in a Bedrock knowledge base), fence by the parent's name or a condition key that names the parent, not by the new child's tag. CloudFormation creates the child with the stack's tags, so it carries the creating app's `app` tag, and a tag rule alone lets App A create a child inside App B's parent. ECS authorizes `CreateService` and `RunTask` against the new service or task, with the cluster only in the `ecs:cluster` condition key; S3 Vectors authorizes `CreateIndex` against the new index. So the ECS statements add a deny on any cluster outside `cluster/<id>-*` (CloudFormation-generated cluster names start with the stack name), and S3 Vectors is matched by name, like S3, with a deny on every other bucket. Cognito clients and groups, and knowledge-base data sources, are authorized against the parent's ARN, so the parent's tag already fences them. Check every tag-scoped service you add for the same case:

```json
[
  {
    "Sid": "EcsOnlyOwnClusters",
    "Effect": "Deny",
    "Action": [
      "ecs:CreateService",
      "ecs:UpdateService",
      "ecs:DeleteService",
      "ecs:RunTask",
      "ecs:StartTask",
      "ecs:StopTask",
      "ecs:CreateTaskSet",
      "ecs:UpdateTaskSet",
      "ecs:DeleteTaskSet",
      "ecs:UpdateServicePrimaryTaskSet"
    ],
    "Resource": "*",
    "Condition": {
      "Null": {
        "ecs:cluster": "false"
      },
      "ArnNotLike": {
        "ecs:cluster": "arn:aws:ecs:*:APPS_ACCOUNT:cluster/${aws:PrincipalTag/app}-*"
      }
    }
  },
  {
    "Sid": "VectorBuckets",
    "Effect": "Allow",
    "Action": "s3vectors:*",
    "Resource": [
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*",
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*/index/*"
    ]
  },
  {
    "Sid": "VectorBucketsOnlyOwn",
    "Effect": "Deny",
    "Action": [
      "s3vectors:CreateIndex",
      "s3vectors:DeleteIndex",
      "s3vectors:PutVectors",
      "s3vectors:DeleteVectors",
      "s3vectors:GetVectors",
      "s3vectors:QueryVectors",
      "s3vectors:ListVectors",
      "s3vectors:PutVectorBucketPolicy",
      "s3vectors:DeleteVectorBucketPolicy",
      "s3vectors:DeleteVectorBucket",
      "s3vectors:TagResource",
      "s3vectors:UntagResource"
    ],
    "NotResource": [
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*",
      "arn:aws:s3vectors:*:APPS_ACCOUNT:bucket/${aws:PrincipalTag/app}-*/index/*"
    ]
  }
]
```

**Service-linked roles.** The first deploy of some services in an account creates their service-linked role. Allow `iam:CreateServiceLinkedRole` on `arn:aws:iam::ACCOUNT:role/aws-service-role/*` with `StringEquals` `iam:AWSServiceName` listing only the services the platform's apps use: `rds.amazonaws.com` (RDS), `dsql.amazonaws.com` (DSQL), `runtime-identity.bedrock-agentcore.amazonaws.com` (AgentCore runtimes).

**CloudFront configuration types can't be scoped.** CloudFront origin access controls and cache, origin-request and response-headers policies are named by id and support no tag condition, so no statement can scope them to one app. Granting their `Create`, `Get`, `Get…Config`, `Update` and `Delete` actions on `origin-access-control/*`, `cache-policy/*`, `origin-request-policy/*` and `response-headers-policy/*` is an accepted exception: they hold configuration, not data, but App A's deploy could change or delete one of App B's. If that's not acceptable, leave them out and deploy those resources from the platform.

**AgentCore runtimes are scoped by tag; their workload identities aren't.** A runtime's name can't carry `<id>-` (no hyphens allowed), so scope `AWS::BedrockAgentCore::Runtime` by tag, as for the other tag-matched services: allow `bedrock-agentcore:CreateAgentRuntime` and `TagResource` only with `aws:RequestTag/app` equal to the caller's, allow `bedrock-agentcore:*` on `runtime/*` only with `aws:ResourceTag/app` equal to the caller's, deny any resource tagged as another app, and deny changing or removing the `app` tag. CloudFormation also creates each runtime's workload identity in the account-wide `default` directory, which carries no app tag, so `CreateWorkloadIdentity`, `GetWorkloadIdentity`, `UpdateWorkloadIdentity` and `DeleteWorkloadIdentity` on `workload-identity-directory/default` and `workload-identity-directory/default/workload-identity/*` are an accepted exception: App A's deploy could change or delete one of App B's workload identities. The service-linked role (above) is still needed. Likewise `AWS::ApiGateway::Account` is an account-level setting shared by every app in the region; set it from the platform.

**Size.** IAM limits a managed policy to 6,144 characters, not counting white space. The role fence is about 2,500 characters and the API Gateway statements about 1,400, so with statements for the services a typical AWS Blocks app uses, `apps-exec` goes over the limit. Split it, whole statements in order, into several shared policies (for example `apps-exec`, `apps-exec-2` and `apps-exec-3`, the role fence in the first); staying around 5,000 characters each leaves room to add statements later without another policy, which every app's bootstrap would then need. Pass them all, comma-separated, to `cdk bootstrap --cloudformation-execution-policies`. `NoEditingTheSharedPolicies` covers every `apps-exec…` policy.

#### The deploy guard

CDK's default bootstrap deploy role may change or delete *any* stack, and CloudFormation reuses a stack's previous service role when a request omits one, so without a guard App A's pipeline could deploy into — or delete — App B's stack as App B's execution role. The guard is one shared policy, `apps-deploy-guard`, attached to every app's CDK bootstrap **deploy** role; `${aws:PrincipalTag/app}` is that deploy role's own `app` tag:

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
        "cloudformation:GetTemplate",
        "cloudformation:CreateStackRefactor",
        "cloudformation:ExecuteStackRefactor"
      ],
      "NotResource": [
        "arn:aws:cloudformation:*:APPS_ACCOUNT:stack/${aws:PrincipalTag/app}/*",
        "arn:aws:cloudformation:*:APPS_ACCOUNT:stack/${aws:PrincipalTag/app}-*/*"
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
        "ArnNotLike": {
          "cloudformation:RoleArn": "arn:aws:iam::APPS_ACCOUNT:role/cdk-${aws:PrincipalTag/app}-cfn-exec-role-APPS_ACCOUNT-*"
        }
      }
    },
    {
      "Sid": "DeleteOnlyWithThisAppsExecutionRole",
      "Effect": "Deny",
      "Action": "cloudformation:DeleteStack",
      "Resource": "*",
      "Condition": {
        "Null": {
          "cloudformation:RoleArn": "false"
        },
        "ArnNotLike": {
          "cloudformation:RoleArn": "arn:aws:iam::APPS_ACCOUNT:role/cdk-${aws:PrincipalTag/app}-cfn-exec-role-APPS_ACCOUNT-*"
        }
      }
    },
    {
      "Sid": "StackTagAppIsThisApp",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "NoStackRetagging",
      "Effect": "Deny",
      "Action": "cloudformation:TagResource",
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringEquals": {
          "aws:TagKeys": [
            "app"
          ]
        },
        "StringNotEquals": {
          "aws:RequestTag/app": "${aws:PrincipalTag/app}"
        }
      }
    },
    {
      "Sid": "NoStackUntagging",
      "Effect": "Deny",
      "Action": "cloudformation:UntagResource",
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
      "Sid": "NoResourceImport",
      "Effect": "Deny",
      "Action": "cloudformation:CreateChangeSet",
      "Resource": "*",
      "Condition": {
        "Null": {
          "cloudformation:ImportResourceTypes": "false"
        }
      }
    },
    {
      "Sid": "NoPlatformResourceTypes",
      "Effect": "Deny",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack"
      ],
      "Resource": "*",
      "Condition": {
        "ForAnyValue:StringLike": {
          "cloudformation:ResourceTypes": [
            "AWS::CloudFormation::*Hook*",
            "AWS::CloudFormation::TypeActivation",
            "AWS::CloudFormation::*Version",
            "AWS::CloudFormation::Publisher",
            "AWS::CloudFormation::Macro",
            "AWS::CloudFormation::StackSet"
          ]
        }
      }
    },
    {
      "Sid": "NoHookOrRegistryAdmin",
      "Effect": "Deny",
      "Action": [
        "cloudformation:SetTypeConfiguration",
        "cloudformation:ActivateType",
        "cloudformation:DeactivateType",
        "cloudformation:RegisterType",
        "cloudformation:DeregisterType",
        "cloudformation:SetTypeDefaultVersion",
        "cloudformation:PublishType",
        "cloudformation:RegisterPublisher",
        "cloudformation:TestType",
        "cloudformation:CreateStackSet",
        "cloudformation:UpdateStackSet",
        "cloudformation:DeleteStackSet",
        "cloudformation:CreateStackInstances",
        "cloudformation:UpdateStackInstances",
        "cloudformation:DeleteStackInstances",
        "cloudformation:ActivateOrganizationsAccess",
        "cloudformation:DeactivateOrganizationsAccess"
      ],
      "Resource": "*"
    }
  ]
}
```

- `OnlyThisAppsStacks` denies stack changes outside `<id>` and `<id>-…` — including the app's own bootstrap stack (`CDKToolkit-<id>`), which only the platform re-bootstraps. It names the stack actions that take a stack ARN, so `ExecuteChangeSet` (authorized against the stack, not the change set), `UpdateTerminationProtection` and the stack-refactor actions (`CreateStackRefactor`, `ExecuteStackRefactor`, which move resources between stacks) work only on the app's own stacks.
- `OnlyThisAppsExecutionRole` denies creating or changing a stack without naming the app's own execution role (`cdk-<id>-cfn-exec-role-…`), so CloudFormation can't fall back to another stack's role. It uses `ArnNotLike`, the operator for an ARN-typed key such as `cloudformation:RoleArn` (IAM Access Analyzer flags `StringNotLike` there).
- `DeleteOnlyWithThisAppsExecutionRole`: deleting one of the app's own stacks may omit the role — CDK does so when it cleans up a failed first deploy (`ROLLBACK_COMPLETE`) — but a role it names must be the app's own. That's safe: `OnlyThisAppsStacks` confines `DeleteStack` to `<id>` / `<id>-…` stacks, and those can only have been created with the app's own execution role, which is the role CloudFormation reuses. If the platform's bootstrap or template turns on termination protection, a stack whose first create rolled back keeps it, and that cleanup fails until termination protection is turned off; the guard allows `UpdateTerminationProtection` on the app's own stacks, so the pipeline can turn it off for its own `ROLLBACK_COMPLETE` stack, or turn protection on only after the first successful deploy.
- `StackTagAppIsThisApp` denies creating or changing a stack unless the request tags it `app=<id>`, and `NoStackRetagging` / `NoStackUntagging` deny setting a stack's `app` tag to another value or removing it. CloudFormation propagates stack tags to the resources it creates, including types a tag aspect can't reach.
- `NoResourceImport` denies change sets that import existing resources: an import would adopt a resource the app didn't create (another app's) into the app's stack.
- `NoPlatformResourceTypes` and `NoHookOrRegistryAdmin` keep the app's deploy from creating or changing CloudFormation hooks, registry types, macros and stack sets, which act on every stack in the account.

**Prefer attaching it in a custom bootstrap template** (`cdk bootstrap --show-template`, add `apps-deploy-guard` to the deploy role's managed policies and remove `sts:TagSession` from its trust policy, `cdk bootstrap --template <file>`), so CloudFormation owns both; attaching it to the existing deploy role (`cdk-<id>-deploy-role-<account>-<region>`) works, but it's drift outside CloudFormation that a re-bootstrap won't restore, and leaves `sts:TagSession` in place.

**Lambda@Edge (Hosting outside `us-east-1`).** CDK hoists edge functions into a `us-east-1` stack; with `defaults.app` set, AWS Blocks names it `<id>-edge`, so the guard and the execution policy treat it as the app's own. Bootstrap the app in `us-east-1` too (same qualifier, same `app` tag, same execution policy) and attach the guard there.

#### The pipeline

Synthesize with `strict: true` (in the project template, see below), which fails synth on any violation in the IAM report, and confirm that every report names the id the platform gave this app:

```bash
APP_ID=appa NODE_OPTIONS="--conditions=cdk" npx cdk synth --quiet   # fails on any violation (strict: true)
jq -e -s --arg id "$APP_ID" 'length > 0 and all(.[]; .app.id == $id and (.violations | length) == 0)' cdk.out/*.blocks-iam.json
```

`APP_ID` comes from the platform, however it manages ids (a registry, picked by hand, generated): to AWS Blocks it's just a string. It never comes from the app's own repository or code. Fail the pipeline on a non-zero exit from either command.

This is feedback, not the guarantee. Synth runs the app's own code, so a determined app can write any report it likes. What keeps apps apart is IAM: the boundary on every role, the execution role that only creates bounded roles tagged as the app, and the deploy guard. Run synth in a job that has no AWS credentials and no `id-token` permission, and deploy the synthesized assembly (`cdk deploy --app cdk.out`) from a job that has the credentials and doesn't run the app's code.

**Optionally, check the templates themselves too.** The report comes from the app's own synth; the CloudFormation templates in `cdk.out` are what will be deployed. Before deploying, check that every `AWS::IAM::Role` carries the `apps-boundary` boundary and the tag `app=<id>`, and that every stack is named `<id>` or `<id>-…`:

```bash
for t in cdk.out/*.template.json; do
  jq -e --arg id "$APP_ID" '
    [.Resources[]? | select(.Type == "AWS::IAM::Role") | .Properties]
    | all(
        ((.PermissionsBoundary // "") | tojson | test("policy/apps-boundary\\\\?\"")) and
        any(.Tags[]?; .Key == "app" and .Value == $id)
      )' "$t" > /dev/null || { echo "A role in $t lacks the boundary or the app tag"; exit 1; }
done
jq -e --arg id "$APP_ID" '[.artifacts | to_entries[] | select(.value.type == "aws:cloudformation:stack")
  | (.value.properties.stackName // .key)] | all(. == $id or startswith($id + "-"))' cdk.out/manifest.json > /dev/null \
  || { echo "A stack isn't named $APP_ID or $APP_ID-…"; exit 1; }
```

The execution policy and the deploy guard enforce both anyway; the check fails the pipeline before the deploy does, with a clearer message.

**Limits.**

- **It isolates apps from each other, not handlers inside one app.** Every handler in an app still runs as the same role, under the same boundary.
- **Allow-list coverage.** A service the boundary has no statement for is denied at runtime (`AccessDenied`). Add statements for any service your apps use beyond AWS Blocks' own. A few statements are scoped by resource tag rather than name (Cognito, Step Functions, Secrets Manager, KMS and others); check them on a deployed app.
- **Exceptions — cross-app reach the boundary still allows.**
  - `ses:SendEmail` / `SendRawEmail` / `SendBulkEmail` on `*`: App A can send as an identity App B verified. Scope SES by identity if your apps send email.
  - `ec2:DeleteNetworkInterface` on `*` (for VPC Lambdas): App A could delete another app's network interfaces.
  - AgentCore runtimes log to AWS-named log groups, which the boundary allows for writing only.
  - The CloudFront configuration types the execution policy can't scope, if you grant them.
- **VPC-attached compute isn't fully isolated.** An app's own ECS service in its own cluster can name another app's subnets, and its task then runs inside that app's VPC, reaching what that VPC's security groups and endpoints allow (with no security group given, the VPC's default group). The task's network interface is created by ECS's service-linked role, and a subnet is named only by its id, with no condition key carrying its owner's tag, so no shared policy can stop it. Lambda `VpcConfig` and RDS subnet groups very likely have the same gap (not yet verified). To close it, check subnets outside the app's code: a CloudFormation Guard hook that allows only the app's own subnets in `AWS::ECS::Service` / `TaskSet` network configurations, Lambda `VpcConfig` and DB subnet groups (the hook can't tell a subnet's owner by itself, so the platform publishes which subnets belong to which app), or an SCP (service control policy) or per-app policy that names each app's subnets.
- **Runtime API calls aren't isolated.** The boundary allows `execute-api:Invoke` and `execute-api:ManageConnections` on every API in the account (`ApisAccountWide`), because neither can be scoped by name or tag. A compromised app could call another app's IAM-authorized APIs, or post to and disconnect another app's WebSocket clients (Realtime, Agent streaming), and the receiving app's handlers would treat an injected message as genuine. Deploying APIs is still isolated: the execution policy only creates and changes API Gateway APIs tagged as the app. If this gap isn't acceptable, give those apps their own AWS accounts.
- **CDK's cross-region references.** Hosting's `us-east-1` stacks are wired to the app's stack by CDK's cross-region export writer, which is granted `/cdk/exports/*`. The IAM report exempts exactly that grant (its actions on that resource): it's CDK-internal, and the boundary caps it to the exports of the app's own stacks (`/cdk/exports/<id>…`). Likewise, CDK's Lambda@Edge ARN reader's read of `/cdk/EdgeFunctionArn/*` is capped by the boundary to the app's own stack path.
- **Account quotas are shared.** Each app adds roles and a bootstrap stack; at thousands of apps, spread them across several accounts.
- **One account per app remains the stronger model.** A boundary only enforces what its statements cover.

#### The app's side: what to put in your project template

A platform team gives every app the same starting point, so the identity, the boundary and `strict` are there before anyone writes code. Put these files in the platform's own project template (for example a copy of an AWS Blocks starter such as `npm create @aws-blocks/blocks-app@latest my-app -- --template api-only`). `APP_ID` is the app's id, which the platform gives it however it manages ids; the pipeline sets it, and a developer exports it for a sandbox (`APP_ID=<id> npm run sandbox`).

**`aws-blocks/index.cdk.ts`.** The app id is the bootstrap qualifier and the stack name, and `defaults.app` sets the identity. `defaults.app` validates the id at synth (pattern and reserved ids, with the reason), so the entry only has to check that `APP_ID` is set:

```typescript
import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Set by the platform's pipeline (to AWS Blocks, just a string), never chosen by this repository.
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
    permissionsBoundary: 'apps-boundary',
  },
});
```

A sandbox stack is named `<id>-<stackId>-<sandbox id>` (`getStackName({ sandbox: true })` returns `<stackId>-<sandbox id>`).

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

An app deployed before it set `defaults.app` has resources with no `app` tag. The execution policy manages resources of the tag-scoped types — Secrets Manager secrets, KMS keys, Cognito user pools, Step Functions state machines, API Gateway APIs, CloudFront distributions and KeyValueStores, DSQL clusters, ECS clusters, services and task definitions, Bedrock knowledge bases and EC2 VPC resources — only once they're tagged `app=<id>`, including the update that would add the tag, so the first deploy under it fails on them (`AccessDenied`, e.g. on `kms:DescribeKey`). That's on purpose: a policy that let a deploy tag an untagged resource would let any app claim one. The tag-scoped types are the ones marked "tag" in the [per-service rules](#the-shared-execution-policy). Adopt in this order:

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

### Service-principal trust: `aws:SourceAccount` and `aws:SourceArn`

Every IAM role AWS Blocks creates that an AWS service assumes (other than Lambda execution roles) limits that trust to the stack's account and to resources of that service, with an `aws:SourceAccount` (`StringEquals`) and an `aws:SourceArn` (`ArnLike`) condition. Synth checks this on the same set of roles `defaults.permissionsBoundary` covers:

- **Roles AWS Blocks creates** — under an AWS Blocks Building Block or a compute, the backend's own roles, and the stack-level roles a block creates on its behalf (custom-resource providers, `Hosting`'s). A trust without either condition **fails synth**, naming the role's construct path and the principal.
- **Roles your app creates** — your own constructs in the backend module (on the `BlocksStack` or embedded `BlocksBackend`, at stack scope, or under a `Scope` namespace), roles you add to a `BlocksStack` after `BlocksStack.create()`, roles inside a custom Building Block you write (a `Scope` subclass, see [Pattern 3: Custom BB](https://github.com/aws-devtools-labs/aws-blocks/blob/main/docs/guides/extending-with-existing-aws-resources.md#pattern-3-custom-bb)), and the roles CDK creates inside any of these (for example the `EventsRole` of an `events.Rule` that targets a state machine). A trust without either condition gets a **synth warning** instead, and the deploy goes ahead.

Ownership follows who created the role, not where it sits in the construct tree: AWS Blocks marks the constructs its own blocks, computes and stack-level helpers create, and every other covered role is your app's.

A condition only counts under an operator that requires the key and with a value that names an account. The operator must be `StringEquals`, `StringEqualsIgnoreCase`, `StringLike`, `ArnEquals` or `ArnLike`, or one of their `ForAnyValue:` forms. An `…IfExists` operator, a negated operator (`StringNotEquals`, `ArnNotLike`, …), `Null` or a `ForAllValues:` operator doesn't count. Neither does a value of `*` alone, an `aws:SourceAccount` with a wildcard, or an `aws:SourceArn` whose account segment is empty or a wildcard. A value built from tokens is read by its literal parts, so `arn:${stack.partition}:cloudwatch:*:*:alarm:*` is still caught, while a value that starts with a token and has no literal account segment (such as `${topic.topicArn}/*`) counts. The KMS key-policy check below uses the same rules.

Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`) are accepted as they are. So is the `apigateway.amazonaws.com` trust of an API Gateway CloudWatch Logs role, meaning any role that an `AWS::ApiGateway::Account` in the same stack names as its `cloudWatchRoleArn`. That includes the stack-level `BlocksApiGatewayCloudWatchRole` AWS Blocks creates when access logging is on, and the `cloudWatchRole` a CDK `apigateway.RestApi` creates by default. API Gateway does not send `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with that role, so either condition stops log delivery. Any other principal on that role, and `apigateway.amazonaws.com` on any other role, is still checked.

**Resolving the warning.** Add both conditions to the trust statement (but don't condition an API Gateway CloudWatch Logs role: API Gateway doesn't send these keys when it delivers logs, so logs stop arriving. Name it as the `cloudWatchRoleArn` of an `apigateway.CfnAccount`, which the check already accepts, or acknowledge the warning). For a role you create, pass them as the principal's `conditions`. For a role a CDK construct creates with no prop for its trust, set them on the role's CloudFormation resource with a property override; the warning names the statement index (`N`):

```ts
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';

const machine = new sfn.StateMachine(stack, 'Machine', {
  definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(stack, 'Start')),
});
new events.Rule(stack, 'Every5', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
  targets: [new targets.SfnStateMachine(machine)],
});
// The EventsRole the target created trusts events.amazonaws.com in statement 0.
// (A pattern, not rule.ruleArn: the rule already references this role.)
const eventsRole = machine.node.findChild('EventsRole').node.defaultChild as cdk.CfnResource;
eventsRole.addPropertyOverride('AssumeRolePolicyDocument.Statement.0.Condition', {
  StringEquals: { 'aws:SourceAccount': stack.account },
  ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:events:${stack.region}:${stack.account}:rule/*` },
});
```

**Acknowledging it.** To keep a trust as it is, acknowledge the warning id `@aws-blocks/core:serviceRoleTrustWithoutSourceCondition`, on the role or on any construct above it (the stack acknowledges it for every role in the stack):

```ts
cdk.Annotations.of(stack).acknowledgeWarning('@aws-blocks/core:serviceRoleTrustWithoutSourceCondition');
```

**KMS (Key Management Service) key policies.** The same check reads the key policy of every `AWS::KMS::Key` in the same set of scopes. An `Allow` statement that names an AWS service principal must carry one of:

- `aws:SourceAccount` or `aws:SourceArn` ([AWS global condition keys in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-aws.html)); either one is enough;
- for CloudWatch Logs (`logs.<region>.amazonaws.com`, or `.amazonaws.com.cn`), `kms:EncryptionContext:aws:logs:arn` ([Encrypt log data in CloudWatch Logs using AWS KMS](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html)).

A key counts under the same operators and values as for roles (above), so an `…IfExists`, negated, `Null` or `ForAllValues:` operator doesn't scope the statement, and neither does a value that leaves the account open. `aws:SourceOrgID` and `aws:SourceOrgPaths` don't count, because they admit every account in the organization. `kms:ViaService` doesn't count either: it applies when an IAM principal calls through a service, and a service principal's own requests don't carry it.

One principal is exempt: `events.amazonaws.com`, in a statement that grants only `kms:GenerateDataKey*` and `kms:Decrypt`. Amazon SNS documents that `aws:SourceAccount`, `aws:SourceArn` and `aws:SourceOrgID` in a key policy aren't supported for EventBridge publishing to an encrypted topic ([Enable compatibility between event sources from AWS services and encrypted topics](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html#compatibility-with-aws-services)), so either condition stops delivery.

As with roles, a key AWS Blocks creates fails synth, naming the key's construct path, the principal and the statement index; a key your app creates gets a synth warning with the id `@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition`, which you acknowledge the same way:

```ts
cdk.Annotations.of(stack).acknowledgeWarning('@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition');
```

The key `Hosting` creates for its alarm topic grants `cloudwatch.amazonaws.com` with `aws:SourceAccount` and `aws:SourceArn` (this account's alarms in the Region), as [Amazon SNS documents for encrypted topics](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html#compatibility-with-aws-services). Other resource policies and KMS grants aren't checked.
