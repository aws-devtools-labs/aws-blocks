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

- Local dev: `http://localhost:3001/aws-blocks/api`
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
curl -X POST http://localhost:3001/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.greet","params":["World"],"id":1}'
# → {"jsonrpc":"2.0","result":{"message":"Hello, World!"},"id":1}
```

### ApiError / isBlocksError

Typed error handling across the wire.

```typescript
import { ApiError, isBlocksError } from '@aws-blocks/core';

// Throw with HTTP status and error name
throw new ApiError('Not found', 404, { name: 'ItemNotFoundException' });

// Catch with type narrowing
catch (e) {
  if (isBlocksError(e, 'ItemNotFoundException')) { ... }
}
```

### RawRoute

Path-based HTTP routing Building Block for endpoints that need full request/response control — webhooks, REST APIs, health checks, file downloads. Use `ApiNamespace` (RPC) for typed function calls; use `RawRoute` when you need raw HTTP semantics.

```typescript
import { RawRoute } from '@aws-blocks/blocks';

// Explicit path
new RawRoute(scope, 'GetUser', {
  method: 'GET',
  path: '/users/{id}',
  handler: async (context) => {
    const userId = context.request.params.id;
    context.response.send({ id: userId });
  },
});

// Derived path — path omitted, becomes /health from scope chain
new RawRoute(scope, 'health', { method: 'GET', handler: async (ctx) => {
  ctx.response.send({ status: 'ok' });
}});
```

Supports exact paths (`/health`), named parameters (`/users/{id}`), and wildcards (`/files/*`). Path can be omitted — it's derived from scope-chain IDs.

📖 **Full RawRoute documentation (see source repo)**

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
