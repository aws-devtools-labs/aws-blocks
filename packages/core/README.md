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
```

So a real config problem looks like the client throwing `Blocks API URL not configured` (or `... is not configured (source: ...)`), not like a `404` on `/config.json`. If a **deployed** origin keeps serving `{"_placeholder":true}` after a successful deploy, that is a genuine bug: the config upload or the CloudFront invalidation did not land.

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

CDK construct (from the `/cdk` entry point) that deploys a frontend on CloudFront + S3, with a single-origin API proxy when a backend stack is provided.

```typescript
import { Hosting } from '@aws-blocks/core/cdk';

new Hosting(stack, 'Web', {
  root: join(__dirname, '..'),
  buildCommand: 'npm run build',
  api: blocksStack,
});
```

The `framework` option selects the frontend type: `'spa' | 'static' | 'nextjs'`. When omitted, the framework is auto-detected by reading your app's OWN `package.json` (not `node_modules`): a `next` dependency → `nextjs`; otherwise `spa`; and `static` when there is no `package.json`. Set `framework: 'spa'` explicitly to override auto-detection — e.g. when a stray `next` dependency would otherwise trigger an unwanted Next.js/OpenNext build. Full reference lives in the source JSDoc.

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

## CORS Configuration

By default, the Lambda handler does **not** set any `Access-Control-Allow-Origin` header. CORS behavior is controlled entirely by the `CORS_ALLOWED_ORIGINS` environment variable.

### When using Hosting (recommended)

If you use the `Hosting` construct with your API, CORS is handled automatically:

- **Same-origin requests** (frontend fetches through the CloudFront proxy at `/aws-blocks/api`) work without CORS headers since the browser treats them as same-origin.
- **Cross-origin requests** (e.g. direct API Gateway calls) are also covered: when you pass a `BlocksStack` or `BlocksBackend` as the `api` prop, the Hosting construct automatically adds the CloudFront distribution's domain to `CORS_ALLOWED_ORIGINS` on the backend Lambda. You do **not** need to configure CORS manually.

In sandbox mode, the localhost pattern is also preserved so your local dev frontend still works.

### Local development (`npm run dev`)

The dev server automatically allows `localhost` / `127.0.0.1` origins. No configuration needed.

### Sandbox deployments

The sandbox CLI automatically sets `CORS_ALLOWED_ORIGINS=^https?://(localhost|127\.0\.0\.1)(:\d+)?$` so your local frontend can reach the deployed sandbox API.

### Production (frontend hosted separately)

If your frontend is hosted on a different domain (e.g., Vercel, Netlify), set the `CORS_ALLOWED_ORIGINS` environment variable on your Lambda:

```typescript
// aws-blocks/index.cdk.ts
blocksStack.handler.addEnvironment(
  'CORS_ALLOWED_ORIGINS',
  'https://myapp\\.com,https://staging\\.myapp\\.com'
);
```

Each entry is treated as a **regex pattern** (anchored with `^` and `$`). Examples:

| Pattern | Matches |
|---------|---------|
| `https://myapp\\.com` | Exact match for `https://myapp.com` |
| `https://.*\\.myapp\\.com` | Any subdomain of `myapp.com` |
| `^https?://(localhost\|127\\.0\\.0\\.1)(:\\d+)?$` | Localhost/127.0.0.1, any port, http or https (sandbox) |
| `.*` | All origins (escape hatch — use with caution) |

Multiple patterns are comma-separated. If a pattern is invalid regex, it falls back to literal string match.

If an origin doesn't match any pattern, the handler omits the `Access-Control-Allow-Origin` header (browser blocks the response) and logs a `[CORS]` warning to CloudWatch.
