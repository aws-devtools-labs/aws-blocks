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

Each method you define becomes a public, internet-reachable RPC endpoint. There is **no authentication by default** — a method is callable by anyone until you gate it. Auth is opt-in, per method, by calling an auth Building Block at the top of the handler:

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

The local mock applies no auth either, so an ungated method passes every local check and still ships callable by anyone. See your auth block's README (e.g. `@aws-blocks/bb-auth-cognito`) for `requireAuth` / `requireRole`.

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
| `-32601` | Method not found | The requested namespace or method is not exported by the backend. |
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

- **Every path reaches your backend.** Catch-all proxy resources forward every method and path to the backend Lambda, which dispatches JSON-RPC and your `RawRoute`s, so adding a `RawRoute` creates no AWS resources. Each namespace also has its own path (`/aws-blocks/api/{namespace}`), which the gateway can route to a different compute without changing the app's endpoint.
- **Throttling** is on by default from `defaults.throttling` (sandbox 200 requests/s with a 400 burst, production 1000/2000). **Structured JSON access logs** are opt-in via `defaults.accessLogging`; each entry records the matched route (`resourcePath`) — the route template, so requests served by the catch-all resources (every namespace on the default compute, every `RawRoute`) log as their `{proxy+}` resource rather than the path called.
- **Limits:** the gateway times out a request after 29 seconds and caps payloads at 10 MB. Run longer work in an `AsyncJob`.
- **WAF** is not included by default. Associate a `REGIONAL` WebACL with the gateway's stage (`new wafv2.CfnWebACLAssociation(stack, 'ApiWaf', { resourceArn: stack.gateway.deploymentStage.stageArn, webAclArn })`, with `wafv2` from `aws-cdk-lib/aws-wafv2`), or enable it on the CloudFront distribution when you use `Hosting` (`waf: { enabled: true }`).

### API front door

How the backend's API is exposed to clients is chosen with the `apiFrontDoor` prop on `BlocksStack` / `BlocksBackend` (default `'apigateway'`):

- **`'apigateway'`** (default) — clients call the stack's API Gateway endpoint directly, on its own `execute-api` domain. Nothing extra to deploy.
- **`'cloudfront'`** — Blocks puts a CloudFront distribution in front of that gateway (and builds the gateway as a regional endpoint, so there is a single CloudFront layer); clients call the distribution's domain instead.

Under either tier, the URL clients should call is `publicApiUrl` on the stack or backend — for a `BlocksStack` that is also the `ApiUrl` stack output. With `'cloudfront'` it is the distribution's URL + `/aws-blocks/api`; otherwise it equals `apiUrl`, the gateway's own URL.

The default is a constant — it is never derived from the app's shape, so adding or removing Building Blocks never silently changes how the API is exposed.

Either tier serves the API at the same path. The typed client (and any manual caller) POSTs JSON-RPC to a per-namespace path:

```
POST /aws-blocks/api/{namespace}
```

where `{namespace}` is the backend export name (`export const api = …` → `api`). The bare `POST /aws-blocks/api` form still works for back-compat. Either way the request body's `method` (`"api.greet"`) names the namespace that runs; a per-namespace path must be exactly `/aws-blocks/api/{namespace}` and name the same namespace, or the call fails with a JSON-RPC `-32600` Invalid Request. Internally the shared gateway routes each namespace's path to the compute that hosts it; by default every namespace runs on the single default compute, so every path lands on the same function.

**Hosting is same-origin.** When you pass the backend to the `Hosting` construct, the frontend and the API are served from one origin, so the browser treats `/aws-blocks/api/*` calls as same-origin and no CORS configuration is needed (see the CORS Configuration section below). With `'cloudfront'`, Hosting's front door takes the front-door role and no second distribution is created. This holds for every `Hosting` `frontDoor` that proxies the API same-origin (the CloudFront default, `alb`, `apiGateway`, `stacked`, `custom`); `'none'` serves static files only, so the browser calls the API cross-origin.

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

The auth blocks' recommended client path (`setAuthState()` / `getAuthState()`) **returns** a failed `AuthState` instead of throwing, so there is no `Error` for `isBlocksError` to inspect. `hasAuthError` is the equivalent guard for that returned object: it compares `state.errorName` to `name` and narrows the type. It's a plain equality check, so a `null` / `undefined` state and a state with no `errorName` both return `false` and no defensive wrapping is needed.

```typescript
const next = await authApi.setAuthState({ action: 'signIn', username, password });
if (hasAuthError(next, AuthBasicErrors.InvalidCredentials)) {
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
| `monitoring` | ✓ | ✓ (`enabled` only, off unless set) | – | `router.monitoring` (`enabled` only) | ✓ |
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
- `@aws-blocks/bb-auth-basic` — Username/password authentication
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

Some platforms deploy many independently written apps, often generated by AI (artificial intelligence) coding agents, through one CI (continuous integration) pipeline into **one AWS account**. Each app's CDK (Cloud Development Kit) code decides the permissions of its own roles. Nothing in the app stops it from granting itself another app's resources: a single `AppSetting.fromExisting(scope, 'x', { name: '/apps/other-app/secret', secret: true })` gives App A read access to App B's secret, and the deploy succeeds.

**The strongest isolation is one AWS account per app** (AWS Organizations with SCPs (Service Control Policies)). When apps must share an account, the platform can enforce a per-app ceiling at deploy time, outside the apps' code. It takes three parts:

| Part | Who provides it |
|---|---|
| 1. A boundary policy that only allows each app its own resources | The platform |
| 2. **Every** role the app creates carries that boundary and the app's tag | AWS Blocks (`defaults.permissionsBoundary`) plus the platform's tag |
| 3. The deploy role refuses any role created without them | The platform |

**1. The boundary policy.** One shared managed policy can serve every app by using ABAC (attribute-based access control): the policy variable `${aws:PrincipalTag/app}` resolves to the calling role's `app` tag at request time. This example lets each app read only SSM (AWS Systems Manager) parameters under its own `/apps/<app>/` path:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "*", "Resource": "*" },
    {
      "Sid": "OnlyOwnAppParameters",
      "Effect": "Deny",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "NotResource": "arn:aws:ssm:*:*:parameter/apps/${aws:PrincipalTag/app}/*"
    },
    {
      "Sid": "UntaggedRolesReadNoParameters",
      "Effect": "Deny",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": "*",
      "Condition": { "Null": { "aws:PrincipalTag/app": "true" } }
    }
  ]
}
```

The first statement keeps the ceiling open for everything else, so the boundary only removes the cross-app reads. The last one stops a role with no `app` tag from reading any app's parameters, so leaving the tag off isn't a way around the rule. Narrow the policy for your platform.

**2. In each app.** Point `permissionsBoundary` at the shared policy, keep the app's resources under its own path, and tag the stack with the app's name (the platform should set the tag value, not the app's own code):

```typescript
// aws-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, permissionsBoundary: 'apps-boundary' },
});
cdk.Tags.of(blocksStack).add('app', 'my-app');
```

```typescript
// aws-blocks/index.ts
const apiKey = new AppSetting(scope, 'api-key', { name: '/apps/my-app/api-key', secret: true });
```

AWS Blocks puts the boundary on every role it creates for the app. That includes the CDK helper roles and the roles CDK adds while preparing the app, which CDK's own `@aws-cdk/core:permissionsBoundary` context misses, so the deploy-time check in step 3 doesn't break AWS Blocks deploys.

**3. The deploy role's condition.** Give the CloudFormation execution role that deploys an app IAM (Identity and Access Management) permissions only on these terms, with one execution role per app so the app's tag value can be pinned:

```json
[
  {
    "Effect": "Allow",
    "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"],
    "Resource": "arn:aws:iam::*:role/*",
    "Condition": { "StringEquals": { "iam:PermissionsBoundary": "arn:aws:iam::111122223333:policy/apps-boundary" } }
  },
  {
    "Effect": "Deny",
    "Action": "iam:CreateRole",
    "Resource": "*",
    "Condition": {
      "StringNotEquals": { "aws:RequestTag/app": "my-app" },
      "Null": { "aws:RequestTag/app": "false" }
    }
  },
  { "Effect": "Deny", "Action": "iam:DeleteRolePermissionsBoundary", "Resource": "*" },
  {
    "Effect": "Deny",
    "Action": ["iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:SetDefaultPolicyVersion"],
    "Resource": "arn:aws:iam::111122223333:policy/apps-boundary"
  },
  {
    "Effect": "Deny",
    "Action": ["iam:TagRole", "iam:UntagRole"],
    "Resource": "*",
    "Condition": { "ForAnyValue:StringEquals": { "aws:TagKeys": ["app"] } }
  }
]
```

A role created without the boundary, or tagged as another app, then fails the deploy. The rule denies a wrong `app` tag rather than requiring one, because `cdk.Tags.of()` doesn't reach every role: the CDK custom-resource provider roles (for example the S3 auto-delete and cross-region-reference providers) can't carry tags. Those roles get the boundary but no tag, and the boundary's last statement keeps them out of every app's parameters. A role that has the boundary can't read another app's parameter at runtime (`AccessDenied`), whatever the app's code granted it. The exact action list depends on how your pipeline deploys; test the policy in a sandbox account first.

**Check it in the pipeline.** The IAM report lists every role AWS Blocks created with its boundary and tags, so a pipeline step can verify both before deploying:

```bash
# Fails when any Blocks role lacks the boundary or the app tag
jq -e '[.roles[] | select(.permissionsBoundary == null or ([.tags[] | select(.Key == "app")] | length == 0))] | length == 0' \
  cdk.out/my-app.blocks-iam.json
```

**Limits.**

- **One rule per resource type.** Each service needs its own ABAC statement (SSM paths, Secrets Manager names, S3 (Amazon Simple Storage Service) prefixes, DynamoDB table names…), and not every service supports matching resources to principal tags. Secrets plus one or two other resource types is practical.
- **Name resources by app.** The rules match resource names, so each app's resources must live under its own prefix or path.
- **It doesn't isolate handlers inside one app.** Every handler in the app still runs as the same role, under the same boundary.
- **One account per app remains the stronger model.** A boundary only enforces what its rules cover.
