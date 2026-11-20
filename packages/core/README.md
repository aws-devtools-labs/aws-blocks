# @aws-cdk-blocks/core

Core primitives for building full-stack applications with AWS CDK Blocks.

| Entry point | Documented here |
|---|---|
| `@aws-cdk-blocks/core` | `Scope`, `ApiNamespace`, `RawRoute`, `ApiError`, `isBlocksError`, `hasAuthError` |
| `@aws-cdk-blocks/core/cdk` | `Hosting`, `HostingPresets` |
| `aws-cdk-blocks/cdk` | `BlocksStack`, `BlocksBackend`, `BlocksPresets` |
| `@aws-cdk-blocks/core/server` | `withAuth`, `registerCookieProvider` |
| `@aws-cdk-blocks/core/scripts` | `deploy`, `destroy`, `startSandbox`, `destroySandbox`, `startDevServer` |

## Scope

`new Scope(id: string, options?: ScopeOptions)` defines the boundary for your backend resources.

| `ScopeOptions` | Type | Description |
|---|---|---|
| `parent` | `ScopeParent` (`Scope \| { id: string }`) | The parent scope. Default: the current stack. |
| `compute` | `{ resolve(): { readonly type: 'serverless' \| 'container' } }` (a `Compute` block) | The compute for everything under the scope; see below. |
| `bbName`, `bbVersion` | `string` | Building Block metadata, set by a block's own class. |

```typescript
import { Scope } from '@aws-cdk-blocks/core';

const scope = new Scope('my-app');
```

Pass `compute` to place everything created under a scope, and in its child
scopes, on one `Compute` (`new Scope('reports', { parent: scope, compute })`);
see the `@aws-cdk-blocks/bb-compute` README for what follows it.

A block's resource names (its table, bucket or queue, and its local `.cdk-blocks/local/data`
directory) come from its `fullId`: the scope ids from the root down, joined with
`-`. Two different scope paths that join to the same string, such as
`'user-service' > 'sessions'` and `'user' > 'service-sessions'`, share those
resources and overwrite each other's data. Constructing the second one logs a
warning naming both paths (a `blocks:scope:fullIdCollision` warning at `cdk
synth`); rename one of the scopes. Constructing the same path again is
accepted.

Use lowercase letters, digits and hyphens in scope and block ids. An id is part
of the name of each resource created under it, unescaped, and every service
accepts those characters. The rest depends on the resource:

| Named from the id | Block | Characters its name accepts |
|---|---|---|
| DynamoDB table | `KVStore`, `DistributedTable` | letters, digits, `_`, `.`, `-` |
| SQS queue | `AsyncJob` | letters, digits, `_`, `-` |
| EventBridge Scheduler schedule | `CronJob` | letters, digits, `_`, `.`, `-` |
| S3 bucket | `FileBucket` | lowercase letters, digits, `.`, `-` |
| Cognito user pool | `Auth` | letters, digits, spaces, `_`, `+`, `=`, `,`, `.`, `@`, `-` |
| Systems Manager parameter | `AppSetting` | letters, digits, `_`, `.`, `-`, `/` |
| Secrets Manager secret | `Secret` | letters, digits, `/`, `_`, `+`, `=`, `.`, `@`, `-` |
| Bedrock knowledge base and data source | `KnowledgeBase` | letters, digits, `_`, `-` |

An id is checked at `cdk synth`, not when the scope is constructed:

- Locally any id runs, for example `new Scope('@acme/shop')`.
- `cdk synth` fails once a block under the scope names a resource that does not accept the id, for example a `KVStore`, whose table name cannot contain `@` or `/`. The error names the id, the characters and what the service accepts. The same id is valid with only an `ApiNamespace` under it (which names nothing from the id) or a `Secret` (Secrets Manager accepts `@` and `/`).
- The check covers the DynamoDB, SQS, Scheduler, Cognito, Secrets Manager and Bedrock names above when they are literal strings at synth. `FileBucket` checks its bucket name itself, and `aws-cdk-lib` checks the parameter name of an `AppSetting` that is not a secret.
- Renaming an id renames every resource under it, which replaces those already deployed.

## ApiNamespace

`new ApiNamespace<T>(scope: ScopeParent, label: string, handler: ApiHandler<T>, options?: ApiNamespaceOptions): AsyncAPI<T>`, where `handler` is `(context: BlocksContext) => T`. Each method of the returned object becomes an RPC endpoint and a method of the typed client. Clients call the namespace by the name it is exported under, not by `label`.

```typescript
import { ApiNamespace } from '@aws-cdk-blocks/core';

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!` };
  }
}));
```

Frontend usage (fully typed):

```typescript
import { api } from 'cdk-blocks';

const result = await api.greet('World');
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `compute` | `{ resolve(): { readonly type: 'serverless' \| 'container' } }` (a `Compute` block) | the app's default compute | Routes calls to the namespace-specific path to this compute. To prevent the bare RPC endpoint from running these methods on the default compute, enable [`defaults.strictNamespacePlacement`](#blockspresets-and-defaults). See [API front door](#api-front-door) for paths and time limits. |
| `httpErrorStatus` | `boolean` | `false` | Answer a call that throws an `ApiError` with a `4xx` status with that HTTP status instead of `200`. See [`httpErrorStatus`](#httperrorstatus). |

### Authentication — every method is a public endpoint

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

The local mock applies no auth either, so an ungated method passes every local check and still ships callable by anyone. See the `Auth` README (`@aws-cdk-blocks/bb-auth`) for `requireAuth` / `requireRole`.

### What the RPC endpoint can reach

The RPC endpoint dispatches `<exportName>.<method>` against your backend module's exports. Export `ApiNamespace` values for anything the client should call, and keep Building Block instances unexported (or reach them only through a gated method):

- Callable: the methods your handler's object defines, as its own properties (including any spread in from another object) or as methods its class defines.
- Not callable: members every object inherits (`constructor`, `toString`, `hasOwnProperty`, `__proto__`, …) and properties hidden with `Object.defineProperty`.
- Not callable: the methods of a Building Block, whether it is exported (e.g. `export const todos = new KVStore(scope, 'todos')`) or returned by a handler. Its data is reachable only through the `ApiNamespace` methods you write, where your `requireAuth` gates run.
- `_`-prefixed exports are private: they get no client proxy and are not dispatched.
- `secret()` / `config()` markers are deferred values, not APIs: they get no client proxy and are not dispatched.

Calling a member that is not callable, such as `todos.put`, returns the same "Method not found" error as an unknown name.

### Calling the API over HTTP (JSON-RPC 2.0)

The typed `import { api } from 'cdk-blocks'` client is the normal path. The HTTP form below is for manual verification (curl/Postman) and non-JS clients.

`POST` to one of two RPC paths, on either `apiFrontDoor` tier:

- `/cdk-blocks/api/{namespace}`: the path the typed client and the Swift, Kotlin and Dart clients use. `{namespace}` must be the namespace that the body's `method` names, with nothing after it, or the call fails with a JSON-RPC `-32600` Invalid Request.
- `/cdk-blocks/api`: runs the namespace that the body's `method` names on the default compute. With `defaults.strictNamespacePlacement`, a deployed app answers "Method not found" there for a namespace placed on another compute.

The URL of `/cdk-blocks/api`:

- Local dev: `http://localhost:3000/cdk-blocks/api`. `blocks.dev.port` in `package.json` sets the port: 3000 by default, where one dev server serves the backend and the frontend; 3001 in the templates without a frontend (`api-only`, `backend`, `cron`, `observability`, `sql`) and in the `amplify` overlay.
- Deployed: `publicApiUrl`, which for a `BlocksStack` is the `ApiUrl` stack output.

The body is JSON-RPC 2.0:

```json
{ "jsonrpc": "2.0", "method": "<namespace>.<methodName>", "params": [...], "id": 1 }
```

- `method` is `<namespace>.<methodName>`, where `<namespace>` is the export variable name from `cdk-blocks/index.ts` (e.g., `export const api = ...` → `api`).
- `params` is a positional array of the method's arguments; see [How the server reads `params`](#how-the-server-reads-params-and-what-it-rejects).
- Errors come back as HTTP `200` with an `error` object in the body (per JSON-RPC), not as a non-2xx status, unless the namespace sets [`httpErrorStatus`](#httperrorstatus).

Error responses use these JSON-RPC codes:

| Code | Meaning | When CDK Blocks uses it |
|------|---------|---------------------|
| `-32700` | Parse error | Request body is not valid JSON. |
| `-32600` | Invalid Request | Body is not a valid CDK Blocks JSON-RPC request, such as missing `jsonrpc: "2.0"` or a `method` that is not `namespace.method`. |
| `-32601` | Method not found | The requested namespace is not exported by the backend, or the method is not one the API defines (inherited members such as `toString` don't count). |
| `-32602` | Invalid params | `params` is present and is neither an array nor an object (a string, a number, a boolean or `null`). Application-level validation should throw an `ApiError` with the appropriate HTTP status instead. |
| `-32603` | Internal error | Not used. An unhandled (non-`ApiError`) throw returns code `500`. |
| the `ApiError`'s `status` (`401`, `404`, `409`, …) | | A method threw an `ApiError`; see [ApiError](#apierror--isblockserror--hasautherror). |

`curl` examples and a table of common symptoms are in `npm run docs troubleshooting`.

### `httpErrorStatus`

With `httpErrorStatus: true`, a call that throws an `ApiError` with a `4xx` status is answered with that HTTP status, so status-code-only tooling (API Gateway and CloudFront metrics, access logs, WAF rate rules, a 4xx alarm) sees rejected calls. The body is the same JSON-RPC error, and the typed client decodes it the same way, so `isBlocksError()` is unaffected. `5xx` and other failures stay HTTP `200`. It applies locally and on AWS:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getNote() {
    const user = await auth.requireAuth(context); // signed out → HTTP 401
    return notes.get(user.userId);
  },
}), { httpErrorStatus: true });
```

Turn it on only when every client of the namespace reads the body of a non-2xx response (a hand-written `fetch` that throws on `!response.ok` would not). Two more things to check:

- **Hosting error pages.** `Hosting` fails synth (`HttpErrorStatusErrorPagesError`) when its CloudFront distribution maps 403 or 404 to a page: `errorPages.notFound`, a static build's own `404.html`, or the default not-found page of a static multi-page site. CloudFront custom error responses apply to the whole distribution, `/cdk-blocks/*` included, so a 403 / 404 from such a namespace would reach the browser as that HTML page. Remove the 4xx error pages, or leave `httpErrorStatus` off for the namespace. 401, 409 and 429 are not mapped.
- **Dart clients with bearer tokens.** With an `authProvider`, the Dart client treats any HTTP 401 as an expired token: it refreshes and runs the method once more, so a method that throws 401 after a side effect runs twice. Put the guard first — `requireAuth()` as the first statement, or `auth.protect`, which runs it before any of the method's code — and keep any method that can still fail with 401 later idempotent. The Swift and Kotlin clients decode the error the same way on any status, and do not retry.

### Closed connections and the single resend (Node clients)

A deployed API (API Gateway, a load balancer) can close an idle connection at any moment. If that close crosses your next call, Node's `fetch` fails it with `TypeError: fetch failed` (cause `SocketError: other side closed`, `ECONNRESET` or `EPIPE`) and does not resend it. This shows up in CLIs, SSR servers and scripts after a few idle seconds. The typed client handles it:

- It resends the identical request once on a new connection when `fetch` fails, before the response headers arrived, with `TypeError: fetch failed` whose cause is an undici socket error (`UND_ERR_SOCKET`, for example `other side closed`), `ECONNRESET` or `EPIPE`. A partial status line followed by a close counts too.
- Delivery is at-least-once. The client matches on the error alone, so the same failure on a fresh connection, such as a server that read the request and crashed before answering, is resent too, and the method runs twice. The server can't tell a resend from a new call. Keep state-changing methods idempotent where a duplicate would matter.
- Behind API Gateway or CloudFront a crashed backend answers with a `5xx`, which is not retried.
- Nothing else is retried: not a second connection failure, not a timeout or abort, not a failure after the response headers arrived (while reading the body), not an HTTP or JSON-RPC error.
- Browsers do this resend themselves, so frontend behaviour is the same with and without it.

To turn the resend off (at-most-once delivery; the failure reaches your code instead), pass `retryStaleConnection: false`:

```ts
import { ApiNamespaceClient } from 'aws-cdk-blocks/client';

const api = ApiNamespaceClient<typeof import('./cdk-blocks/index.js').api>('api', {
  retryStaleConnection: false,
});
```

The generated client's `generateClient` takes the same options: `generateClient({ url, retryStaleConnection: false })`.

Your own `fetch` calls (to a `RawRoute`, or the JSON-RPC endpoint called by hand) don't get this. In Node, resend a request yourself when it fails with one of those causes and is safe to repeat.

### How the server reads `params` (and what it rejects)

`params` becomes the positional argument list your method is called with:

| Body `params` | Arguments the method receives |
|---|---|
| `["World", 42]` (array) | `('World', 42)`, used as-is |
| `{"name":"World","times":42}` (object) | `('World', 42)` via `Object.values()`, so **key insertion order decides argument order** |
| omitted | `()`, no arguments |
| any other value, `null` included | none: the call fails with `-32602` |

Prefer the array form: a named object is only safe when its keys are written in the same order as the method signature.

A JSON-RPC batch (a top-level JSON array as the whole body) is not supported: it returns `-32600` with `id: null` and HTTP `200`. Send one call per request.

### Runtime config (`/.blocks-sandbox/config.json`)

The generated client does not hardcode the API URL; it resolves one at first call, in this order:

1. `BLOCKS_API_URL` env var (set by the Hosting construct on SSR compute, and by `npm run dev` on the frontend command it runs).
2. `BLOCKS_CONFIG` env var (the whole config as JSON).
3. Node.js 22.3 or later only: the file `.cdk-blocks-sandbox/config.json`, read from the process working directory. Only a dev server writes it, with its own local URL. Older Node.js skips this step, so set `BLOCKS_API_URL` there.
4. Browser only: `fetch('/.blocks-sandbox/config.json')`.

Who sets the env vars:

- `Hosting` injects both into every SSR compute function at synth.
- The dev server (`npm run dev`, and the one `npm run sandbox` runs) sets `BLOCKS_API_URL` to its own front door on the frontend dev server it starts, so a Next.js Server Component calls the local server too.
- Set `BLOCKS_API_URL` yourself only when you run the SSR host outside that tooling, like a framework dev server on its own port (`BLOCKS_API_URL=http://localhost:3001/cdk-blocks/api next dev`) or your own container.
- Don't hand-write `BLOCKS_CONFIG`: it is Hosting's serialized `backendConfig`.

Each target records its API URL in a file of its own, which only code that means to target that stage reads:

| File | Written by |
|---|---|
| `.cdk-blocks-sandbox/config.json` | a dev server only |
| `.cdk-blocks-sandbox/config.sandbox.json` | a sandbox deploy |
| `.cdk-blocks-sandbox/config.production.json` | `npm run deploy` |

- A deploy never rewrites `.cdk-blocks-sandbox/config.json`, so it never changes where local tooling points while `npm run dev` runs.
- The template e2e tests call the dev server on `blocks.dev.port`, or the deployed app you name with `TEST_URL`.
- The client refuses, with an error, a `config.json` that holds a deploy's URL (an app deployed with an older version has one), and never calls the stack it names. Start the dev server, which rewrites the file, or set `BLOCKS_API_URL` to call that stack on purpose. The next deploy or destroy moves it to `config.<stage>.json`.

When the URL is wrong or missing:

- Over HTTP the config is at the dotted path `/.blocks-sandbox/config.json`. `/config.json` is not a route, locally or deployed, so a `404` there says nothing about your config.
- `{"_placeholder":true}` is the expected body in the frontend build output (`dist/.blocks-sandbox/config.json`) and on the origin between synth and deploy: the deploy uploads the resolved config over it. A deployed origin that keeps serving it after a successful deploy is a bug: the config upload or the CloudFront invalidation did not land.
- A missing config makes the client throw `Blocks API URL not configured` (or `... is not configured (source: ...)`).
- Under `apiFrontDoor: 'cloudfront'`, `config.production.json` holds the CloudFront domain + `/cdk-blocks/api`, not the `execute-api` URL.
- `npm run docs troubleshooting` has the commands that print each target's config.

```bash
# After a deploy: the URL the deploy recorded (never config.json), and the config uploaded to the origin
cat .cdk-blocks-sandbox/config.production.json
# → { "apiUrl": "https://<id>.execute-api.<region>.amazonaws.com/prod/cdk-blocks/api", "environment": "production" }
#   (under apiFrontDoor:'cloudfront' this is the CloudFront domain + /cdk-blocks/api instead)
curl https://<your-cloudfront-domain>/.blocks-sandbox/config.json
# → {"apiUrl":"/cdk-blocks/api","__blocksBuildId":"<build id>"}
```

The deployed file is public on purpose, in every stage, production included: a browser has no other way to learn the API URL, and `cdk-blocks deploy --wait-live` polls it for `__blocksBuildId` to know the new build is live. Keep serving it; removing the `/.blocks-sandbox/*` route breaks every deployed page. The name says `sandbox` for historical reasons, not because only a sandbox serves it. Hosting writes only values the browser receives anyway:

- `apiUrl`, only when Hosting has an `api`: the same-origin `/cdk-blocks/api` behind every door except `frontDoor: 'none'`. With `'none'` the page calls the API cross-origin, so it is the absolute URL every RPC goes to: the API's public URL (`publicApiUrl`) when it has one, otherwise its `execute-api` URL.
- `__blocksBuildId`: an opaque id for the deploy (a timestamp plus random characters, or a hash of the build's content with `buildId: 'fixed'`).
- Your `backendConfig`, if you set one. Everything in it is published as is (except `apiUrl` and `__blocksBuildId`, which Hosting sets over any key of the same name), so never put a secret or an internal identifier there. The same object is also set as the `BLOCKS_CONFIG` environment variable on SSR functions.

Hosting adds nothing else: no account, stack name or ARN. A region shows up only inside an `execute-api` URL that a `frontDoor: 'none'` page calls directly, which is visible in its network requests anyway. The `config.<stage>.json` files a deploy records locally (`.cdk-blocks-sandbox/config.production.json` above) are separate: they stay on your machine and are never uploaded.

## BlocksStack and BlocksBackend

`await BlocksStack.create(scope: Construct, id: string, props: BlocksStackProps)` creates the app's stack. `await BlocksBackend.create(scope: Construct, id: string, props: BlocksBackendProps)` embeds the same backend as a construct in a stack you own. Import both, and `BlocksPresets`, from `aws-cdk-blocks/cdk`.

```typescript
// cdk-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: BlocksPresets.production,
});
```

| Prop | Type | Default | Description |
|---|---|---|---|
| `backendHandlerPath` | `string` | required | Path of the backend handler file. |
| `backendCDKPath` | `string` | required | Path of the backend module (`cdk-blocks/index.ts`). |
| `defaults` | `BlocksDefaults` | required | Infrastructure defaults for every Building Block; a per-block option overrides the matching default. `create()` throws without it. See [`BlocksPresets` and `defaults`](#blockspresets-and-defaults). |
| `apiFrontDoor` | `ApiFrontDoorTier` (`'apigateway' \| 'cloudfront'`) | `'apigateway'` | How clients reach the API. See [API front door](#api-front-door). |
| `apiWaf` | `ApiWafOptions` (`{ enabled?: boolean; rateLimit?: number; webAclArn?: string }`) | off | AWS WAF in front of the API. See [API WAF](#api-waf-apiwaf). |

`BlocksStackProps` extends the CDK `StackProps`.

| Property | Value |
|---|---|
| `publicApiUrl` | The URL clients send RPC calls to. The `ApiUrl` stack output of a `BlocksStack` is this value. |
| `apiUrl` | The shared gateway's own RPC URL (its `execute-api` address), on either `apiFrontDoor` tier. |
| `gateway` | The shared API Gateway REST API. |
| `executionRole` | The IAM role every CDK Blocks compute runs as. |
| `defaults` | The `defaults` passed to `create()`. |

### `BlocksPresets` and `defaults`

Start `defaults` from `BlocksPresets.sandbox` or `BlocksPresets.production` and override fields with a spread: `defaults: { ...BlocksPresets.production, deletionProtection: false }`.

| Option | Type | `sandbox` | `production` | Description |
|---|---|---|---|---|
| `removalPolicy` | `RemovalPolicy` | `RemovalPolicy.DESTROY` | `RemovalPolicy.RETAIN` | What CloudFormation does with a stateful resource (table, bucket, user pool) when the stack is deleted. |
| `deletionProtection` | `boolean` | `false` | `true` | Enables service-side deletion protection on resources that support it. This is separate from CloudFormation retention and does not protect S3 buckets from direct deletion. |
| `allowedOrigins` | `string[]` | `['^https?://(localhost\|127\\.0\\.0\\.1)(:\\d+)?$']` | `[]` | CORS origins the API accepts. See [CORS Configuration](#cors-configuration). |
| `pointInTimeRecovery` | `boolean \| { retentionDays: number }` | `false` | `true` | Continuous backups on stateful resources that support them (DynamoDB point-in-time recovery: 1–35 days). |
| `logRetention` | `RetentionDays` | `RetentionDays.ONE_WEEK` | `RetentionDays.ONE_YEAR` | Retention of the CloudWatch log groups CDK Blocks manages. |
| `throttling` | `BlocksThrottling` (`{ rateLimit: number; burstLimit: number }`) | `{ rateLimit: 200, burstLimit: 400 }` | `{ rateLimit: 1000, burstLimit: 2000 }` | Requests per second and burst on the shared REST API stage; messages per second on the `Realtime` WebSocket stage. |
| `accessLogging` | `boolean` | `false` | `false` | JSON access logs on the shared REST API and Realtime WebSocket stages. Hosting's CloudFront SSR origin uses `frontDoor.features.serverOrigin.accessLogging` instead. This is also the fallback for `storageAccessLogging`. The API Gateway CloudWatch Logs role is account- and region-wide; enable it in one CDK Blocks stack per account and region. While it is off and `removalPolicy` is not `DESTROY`, synth warns `blocks:apigateway:access-logging-disabled`. |
| `storageAccessLogging` | `boolean` | unset | unset | S3 server access logs for CDK Blocks-provisioned FileBucket buckets. Unset falls back to `accessLogging`. Configure logging on imported buckets separately. |
| `secretsStore` | `BlocksSecretsStore` (`'ssm' \| 'secrets-manager'`) | `'ssm'` | `'secrets-manager'` | Where CDK Blocks stores the secrets it generates (the `Auth` session secret, the `Realtime` connection token key). Changing it on a deployed stack creates new keys, which signs every `Auth` user out once. |
| `vpc` | `BlocksVpcOptions` | unset | unset | A VPC for the app's compute and VPC-resident resources. |
| `permissionsBoundary` | `string \| IManagedPolicy` | unset | unset | See [Cap every role](#cap-every-role-defaultspermissionsboundary). |
| `strictNamespacePlacement` | `boolean` | `false` | `false` | When enabled, each deployed compute serves only the namespaces placed on it. The dev server does not enforce placement. While it is off and a namespace has its own compute, synth warns `blocks:apigateway:bare-endpoint-serves-placed-namespaces`. |
| `appIdentity` | `BlocksAppIdentity` (`{ id: string; reportOnly?: boolean }`) | unset | unset | See [Running many apps in one AWS account](#running-many-apps-in-one-aws-account-a-shared-platform). |

`storageAccessLogging`, `vpc`, `permissionsBoundary`, `strictNamespacePlacement` and `appIdentity` are optional in `BlocksDefaults`; the other options are required, and both presets set them.

### Shared API gateway

A deployed `BlocksStack` / `BlocksBackend` puts one shared API Gateway REST API in front of the whole backend (see [API front door](#api-front-door) for how it is exposed).

- **Every path reaches your backend.** Catch-all proxy resources forward every method and path to the backend Lambda, so adding a `RawRoute` creates no AWS resources. Each namespace also has its own path (`/cdk-blocks/api/{namespace}`), so a namespace given its own compute (`new ApiNamespace(scope, name, handler, { compute })`, see `@aws-cdk-blocks/bb-compute`) is routed there without changing the app's endpoint.
- **Container computes.** The gateway reaches a namespace on a `container` compute through a VPC link and an internal Application Load Balancer that the compute provisions in the app's VPC. Namespaces without a compute, `RawRoute`s and the auth routes stay on the default compute. On the `cloudfront` tier, CloudFront reaches a container namespace straight from the distribution instead (see [API front door](#api-front-door)), so the gateway's throttling, access logs and limits don't apply to it.
- **Throttling** is on by default from `defaults.throttling` (sandbox 200 requests/s with a 400 burst, production 1000/2000).
- **Access logs** are opt-in via `defaults.accessLogging`. Each entry's `resourcePath` is the route template, so requests served by the catch-all resources (every namespace on the default compute, every `RawRoute`) log as their `{proxy+}` resource, not the path called.
- **Limits:** the gateway times out a request after 29 seconds and caps payloads at 10 MB. Run longer work in an `AsyncJob`.

### API WAF (`apiWaf`)

WAF is off by default. Turn it on with `apiWaf` on `BlocksStack` / `BlocksBackend`:

| `apiWaf` | Effect |
|---|---|
| `{ enabled: true, rateLimit? }` | Creates a web ACL with the AWS managed Common rule set and Known Bad Inputs rule set, plus a per-IP rate limit of `rateLimit` requests per 5 minutes (default 1000, minimum 100). The Common rule set's body rules (`SizeRestrictions_BODY`, `CrossSiteScripting_BODY`, `GenericLFI_BODY`, `GenericRFI_BODY`) only count, so normal RPC payloads, including user-written HTML or Markdown, pass. |
| `{ webAclArn }` | Attaches your existing web ACL as-is. Synth checks scope and region when the ARN and relevant region are known; unresolved values are checked at deploy. Behind a `Hosting` door its IP rate rules count CloudFront edge or proxy IPs for browser traffic. |

The web ACL goes on whichever front door clients use:

- `apiFrontDoor: 'apigateway'` — a `REGIONAL` web ACL on the gateway stage, in any region. For the CDK Blocks-managed ACL, rate-limit proxied browser requests at the door. Use the door's WAF if it supports one (see the [Hosting settings matrix](../hosting/README.md)); otherwise provide your own rate limiting:
  - a CloudFront `Hosting` that claims the API sends a marker header the rate rule exempts;
  - behind any other door (ALB, API Gateway, your own, or a CloudFront edge over a router) the rate rule is left off and synth warns (`blocks:api-waf:no-rate-limit-behind-door`).
- `apiFrontDoor: 'cloudfront'` — a `CLOUDFRONT` web ACL on the managed distribution, which also covers the container namespaces it routes straight to their load balancer. AWS only creates these in us-east-1, so in other regions pass `webAclArn` of one created there (`enabled: true` fails synth). Without one, synth warns that those container namespaces have no rate limit (`blocks:api:direct-routes-without-waf`).
- `apiFrontDoor: 'cloudfront'` with a CloudFront-backed `Hosting` fronting the API: the API is served from Hosting's distribution, so set the WAF on Hosting (`frontDoor: { features: { waf: { enabled: true } } }`); `apiWaf` then creates nothing and synth warns (`blocks:api-waf:deferred-to-hosting`).
- Not covered: the gateway's `execute-api` endpoint under `'cloudfront'` (callable directly, and reached by browser traffic that a non-CloudFront `Hosting` door forwards), and `bb-realtime`'s WebSocket API (AWS WAF can't attach to API Gateway WebSocket APIs).

### API front door

The `apiFrontDoor` prop on `BlocksStack` / `BlocksBackend` chooses how the backend's API is exposed to clients:

- **`'apigateway'`** (default) — clients call the stack's API Gateway endpoint directly, on its own `execute-api` domain. Nothing extra to deploy.
- **`'cloudfront'`** — CDK Blocks puts a CloudFront distribution in front of that gateway; clients call the distribution's domain instead.

Under either tier, the URL clients should call is `publicApiUrl` on the stack or backend — for a `BlocksStack` that is also the `ApiUrl` stack output. With `'cloudfront'` it is the distribution's URL + `/cdk-blocks/api`; otherwise it equals `apiUrl`, the gateway's own URL.

Either tier serves the API at the same paths (see [Calling the API over HTTP](#calling-the-api-over-http-json-rpc-20)). By default every namespace runs on the default compute. Pass `{ compute }` as the fourth `ApiNamespace` argument to run a namespace on its own `Compute`; the `@aws-cdk-blocks/bb-compute` README lists what that changes (and what it doesn't), including which callers reach the namespace's compute. Where a namespace on a `container` compute is served from:

- With `'cloudfront'`, its path has a CloudFront behavior of its own — on the managed distribution, or on `Hosting`'s default CloudFront door when it fronts the API — that goes straight to the container's load balancer: calls can run up to 60 seconds. Every other path reaches the gateway.
- The `stacked` door's edge sends `/cdk-blocks/*`, container namespaces included, through its ALB router to the gateway, so those calls keep the gateway's 29-second limit.
- A container namespace whose VPC has no public subnets (an isolated VPC) also stays on the gateway, and synth warns (`blocks:api:direct-routes-without-public-subnets`). The check reads the VPC's public subnets, so for an imported VPC (`Vpc.fromVpcAttributes`) list its `publicSubnetIds`.
- On the `apigateway` tier, a CloudFront `Hosting` sends container namespaces to the gateway like every other path.

When you pass the backend to the `Hosting` construct, the frontend and the API are served from one origin, so no CORS configuration is needed. The `'none'` door is the exception: it serves static files only, so the browser calls the API cross-origin. With `'cloudfront'`:

- A CloudFront-backed `Hosting` door (the CloudFront default, or the `stacked` door's edge) takes the front-door role, and no second distribution is created.
- Behind the `alb`, `apiGateway` and `custom` doors the API keeps its own distribution, and `ApiUrl` stays on it for every other client.

Neither tier makes CloudFront the only way in: the gateway's own `execute-api` URL stays publicly reachable, so a WebACL on a CloudFront distribution doesn't cover direct calls to it.

> ⚠️ **Switching tiers — or adding or removing `Hosting` under `'cloudfront'` — changes the API's endpoint domain.** Browser auth cookies and sessions are bound to the origin that set them, so the change invalidates every existing cookie/session — users are signed out and must sign in again. Pick a tier, and decide on Hosting, before you have real users, and treat a later change as a breaking migration.

## ApiError / isBlocksError / hasAuthError

Typed error handling across the wire. All three are exported from `@aws-cdk-blocks/core`, and re-exported from `aws-cdk-blocks`.

```typescript
import { ApiError, isBlocksError } from '@aws-cdk-blocks/core';

// Throw with HTTP status and error name
throw new ApiError('Not found', 404, { name: 'ItemNotFoundException' });

// Catch with type narrowing
catch (e) {
  if (isBlocksError(e, 'ItemNotFoundException')) { ... }
}
```

### `new ApiError(message, status, options?)`

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

How `status` reaches the client over JSON-RPC: an uncaught error inside an RPC method is encoded as an error response whose `code` is the `ApiError`'s `status`. `name` and `retriable` ride along in `error.data`. A non-`ApiError` throw becomes code `500` with no `data.name`.

```jsonc
// throw new ApiError('Username already taken', 409,
//   { name: 'ConditionalCheckFailedException', retriable: true })
{ "jsonrpc": "2.0", "id": 1, "error": {
  "code": 409,
  "message": "Username already taken",
  "data": { "name": "ConditionalCheckFailedException", "retriable": true }
}}
```

The client rejects with an `ApiError`:

- A JSON-RPC error with a positive code decodes to the same `status`, `name` and `retriable`.
- Reserved JSON-RPC codes (`-32600`, `-32700`, …) decode to `status: 500`.
- A response that is not a JSON-RPC envelope, such as a gateway's own `429 {"message":"Too Many Requests"}` or an HTML error page: `status` is the HTTP status (`502` if that status was 2xx) and `message` is the body's `message` when present, else `HTTP <status>`.

### `isBlocksError(e, name)`

`isBlocksError<N extends string>(e: unknown, name: N): e is Error & { name: N }` is true when `e` is an `Error` whose `name` equals `name`, and narrows the type. The same check works on the server and in the client, because a decoded `ApiError` keeps its `name`.

### `hasAuthError(state, name)`

```typescript
import { hasAuthError } from '@aws-cdk-blocks/core';

function hasAuthError<T extends { errorName?: string }, N extends string>(
  state: T | null | undefined,
  name: N,
): state is T & { errorName: N }
```

`Auth`'s state machine (`setAuthState()` / `getAuthState()`) returns a failed `AuthState` instead of throwing, so there is no `Error` for `isBlocksError` to inspect. `hasAuthError(state, name)` is true when `state.errorName === name`, and narrows the type. A `null` / `undefined` state and a state with no `errorName` give `false`.

In browser code, submit the action with `submitAuthAction` from `aws-cdk-blocks/ui`: it returns the same `AuthState` and also notifies `onAuthChange` / `AuthenticatedContent` subscribers, which a direct `authApi.setAuthState()` call does not.

```typescript
import { AuthErrors, hasAuthError } from 'aws-cdk-blocks';
import { submitAuthAction } from 'aws-cdk-blocks/ui';

const next = await submitAuthAction(authApi, { action: 'signIn', username, password });
if (hasAuthError(next, AuthErrors.NotAuthorized)) {
  // unknown user or wrong password → offer sign-up
}
```

Browser code imports `AuthErrors` and `hasAuthError` from `aws-cdk-blocks`, like the backend: its browser entry re-exports every block's error constants and the error matchers. The string name, `'NotAuthorizedException'`, works too.

Rule of thumb: **thrown error → `isBlocksError`; returned `AuthState` → `hasAuthError`.** Match on the block's error constant, never on the human-facing `error` string.

### Monitoring failed RPC calls

A failed RPC call (a method that throws, or a call to an unknown API namespace or method) reaches the client as a JSON-RPC error inside an HTTP 200 response, and the Lambda invocation itself succeeds, so Lambda's `Errors` metric does not count it. On Lambda each failed call writes one log line in CloudWatch embedded metric format, which emits this metric:

| | |
|---|---|
| Namespace | `CDKBlocks` |
| Metric | `RpcErrors` (Count) |
| Dimensions | `FunctionName`, `StatusClass` (`4xx` for a client error such as an `ApiError` with status 403, `5xx` for anything else, including an unexpected error and the handler's 504 timeout) |
| Also in the log line | `Status`, `ApiNamespace` and `Method`, searchable with CloudWatch Logs Insights |

Alarm on `StatusClass = 5xx` to catch server failures; `4xx` counts include expected rejections such as an unauthenticated call. The error message is never written to the metric line.

API namespaces on a `container` compute do not emit this metric.

## RawRoute

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
import { RawRoute } from 'aws-cdk-blocks';

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

Registration rules:

- Routes must be constructed while the backend module is loading (top level of `cdk-blocks/index.ts`, or from a block's constructor). Registering after the handler is created throws.
- `/cdk-blocks`, `/cdk-blocks/api` and everything under `/cdk-blocks/api/` are reserved for RPC dispatch. The same restrictions apply under the legacy `/aws-blocks` alias. `/` is not routable; use a sub-path.
- The same `method` + `path` twice throws `RawRouteErrors.DuplicateRoute`; catch it with `isBlocksError(e, RawRouteErrors.DuplicateRoute)`.

## withAuth (SSR cookie forwarding)

`withAuth<T>(fn: () => Promise<T>, cookies?: string | null, options?: WithAuthOptions): Promise<T>`, where `WithAuthOptions` is `{ allowAnonymous?: boolean }`, from the `@aws-cdk-blocks/core/server` entry point (also re-exported as `aws-cdk-blocks/server`), forwards the request's cookies to every CDK Blocks API call made inside `fn`. During SSR (server components / loaders) the browser's cookies aren't attached to those calls otherwise.

- `withAuth` throws a `401` `ApiError` when no cookies are found.
- For pages that signed-out visitors can see, pass `{ allowAnonymous: true }` as the third argument: `fn` then runs without cookies, as a signed-out browser call would. Public methods work, and methods gated with `auth.requireAuth` still answer `401`. This works whatever the header value is for a request without cookies (`null`, `undefined` or `''`), and with built-in detection: `withAuth(fn, undefined, { allowAnonymous: true })`.

Where the cookies come from:

| Framework | Cookies |
|---|---|
| Next.js | Built in: read through `cookies()` from `next/headers`, so with no second argument `withAuth` works anywhere that call does: server components, route handlers and server actions. |
| Nuxt | Built in: read from the active Nitro request. Requires `nitro: { experimental: { asyncContext: true } }` in `nuxt.config.ts`. |
| Any other | Pass the request's `Cookie` header as the second argument, or register a provider once with `registerCookieProvider`. |

```typescript
import { withAuth } from 'aws-cdk-blocks/server';

// Next.js server component or route handler: cookies come from next/headers' cookies()
const posts = await withAuth(() => api.listMyPosts());

// Other frameworks: pass cookies explicitly as the 2nd arg…
const posts = await withAuth(() => api.listMyPosts(), request.headers.get('cookie'));
// …or register a provider once via registerCookieProvider.
```

## Hosting

CDK construct (from the `/cdk` entry point) that deploys a frontend on S3 behind a front door — CloudFront by default, or another door (`frontDoor`, below) — with a single-origin API proxy when a backend stack is provided.

```typescript
import { Hosting } from '@aws-cdk-blocks/core/cdk';

new Hosting(stack, 'Web', {
  root: join(__dirname, '..'),
  buildCommand: 'npm run build',
  api: blocksStack,
});
```

The `framework` option selects the frontend type: `'spa' | 'static' | 'nextjs'`. When omitted, it is detected from your app's own `package.json` (not `node_modules`): a `next` dependency → `nextjs`; otherwise `spa`; and `static` when there is no `package.json`. Set `framework: 'spa'` to override the detection, for example when a stray `next` dependency would trigger a Next.js/OpenNext build.

`buildCommand` runs during synth, with `BLOCKS_API_URL` set to the backend the frontend talks to, and then the framework adapter runs its own build (OpenNext, Nitro, Astro, SvelteKit). Two synths skip both:

- **Destroy.** `npm run destroy` and `npm run sandbox:destroy` reuse the build output already on disk and build only when there is none, for example on a fresh clone. Each framework adapter checks the output it deploys: a Next.js destroy reuses the `.open-next/` output of an earlier deploy, and with only `.next/` (after a plain `next build`) OpenNext still builds. An exported `BLOCKS_SKIP_FRONTEND_BUILD=1` doesn't apply to a destroy.
- **A deploy with `BLOCKS_SKIP_FRONTEND_BUILD=1`**, for example `BLOCKS_SKIP_FRONTEND_BUILD=1 npm run deploy`, deploys what is already in the build output directory. A missing build output (the output directory, or the output the framework adapter deploys, such as Next.js's `.open-next/`) fails the synth with a message naming the variable. The build bakes in `BLOCKS_API_URL`, so only reuse a build made for the same backend; a deploy never reuses one on its own.

`buildRetentionDays` (default 30) is how many days superseded builds are kept for rollback. It maps to the hosting construct's `storage.buildRetentionDays` and must be ≥ `skewProtection.maxAge` in days. The [`@aws-cdk-blocks/hosting` README](../hosting/README.md) has the retention and cleanup rules.

### Front door and its settings

`frontDoor` picks the public entry point:

- omitted: CloudFront (the default);
- `{ kind: 'alb' }`, `{ kind: 'apiGateway', api?: 'http' | 'rest' }`, `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` or `{ kind: 'custom', door }`;
- `'none'`: a public S3 website bucket.

The settings the app asks the door for go in `frontDoor.features`, typed per kind, so a setting the chosen door doesn't implement does not compile. `{ features }` with no `kind` is the CloudFront default with settings:

```typescript
import { PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import { Hosting } from '@aws-cdk-blocks/core/cdk';

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

The [`@aws-cdk-blocks/hosting` README](../hosting/README.md) documents each door: the settings each kind takes, the stacked door's settings per layer, and writing your own. The rules that fail a synth or a deploy:

- **Plain HTTP.** A door without a certificate serves plain HTTP: the `{ kind: 'alb' }` door without a `certificate` and `features.domain`, and the stacked door's edge → router hop without a router `certificate` and `features.router.domain`. Outside a sandbox deploy, synth fails for the `alb` door with an API (`PlainHttpFrontDoorError`) and for a stacked door whose router is not `internal: true` (`OriginSecretOverPlainHttpError`); a sandbox deploy warns. If the network path is trusted (a private network, or TLS ended upstream), `allowPlainHttp: true` on the `alb`, `custom` or `stacked` door lets a production deploy synthesize.
- **Switching `frontDoor` on a deployed app** replaces the front door: the URL changes (sessions scoped to the old host end), and a custom domain moving from one door to another collides in Route 53 while both exist. Remove it from the old door first.
- **Top-level props.** The top-level `domain`, `waf`, `logging`, `monitoring`, `skewProtection`, `contentSecurityPolicy`, `priceClass`, `geoRestriction`, `quotas`, `ssrDefaultTtl`, `cacheKeyCookies` and `cacheKeyHeaders` props are deprecated aliases of the same names in `frontDoor.features`. Setting one both ways fails synth (`FrontDoorSettingConflictError`), and so does a top-level prop the chosen kind doesn't implement (`UnsupportedFrontDoorSettingError`; the stacked door takes its settings per layer only).

### Preview mode and `HostingPresets`

`HostingPresets` are plain bundles of `Hosting` props, as `BlocksPresets` are for `defaults`. `HostingPresets.preview` is a fast, cheap, disposable shape for ephemeral environments (pull-request previews, per-branch sandboxes); `HostingPresets.production` sets nothing. Spread one first and override settings after it:

```typescript
import { Hosting, HostingPresets } from '@aws-cdk-blocks/core/cdk';

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
| `buildId` | `'fixed'` | A build id keyed on the build's content: an unchanged build keeps it, so a re-deploy skips the asset upload and can hotswap; a changed build gets a new prefix (deleted files stop being served). There is no atomic switch-over |

Each prop also works on its own. `incrementalRegeneration: false` works behind every door. `imageOptimization: false` and `edgeRoutes: 'regional'` need the API Gateway HTTP API door (where `edgeRoutes` defaults to `'regional'`, since that door can't invoke Lambda@Edge), and `buildId: 'fixed'` needs a door without an edge cache (not CloudFront or the stacked door). Any other combination fails synth with `UnsupportedHostingSettingError`.

`npm run sandbox:preview` (in a `create-blocks-app` app) deploys a preview sandbox: the disposable sandbox backend plus the app with `HostingPresets.preview`, and prints its URL.

- It runs `startSandbox({ preview: true, deployOnly: true })`, which sets the CDK context `previewMode=true` next to `sandboxMode=true` (the key is exported as `PREVIEW_MODE_CONTEXT` from `@aws-cdk-blocks/core/scripts`). The app decides what the signal does; the templates add `Hosting` for it (below), so a plain `npm run sandbox` stays backend-only.
- On a re-deploy, a backend-only change is hotswapped; a changed frontend build or an infrastructure change does a full deploy.
- `sandbox`, `sandbox:deploy` and `sandbox:preview` deploy one stack: a plain sandbox deploy removes the preview (it warns first), and running `sandbox:preview` again adds it back at a new URL.

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

`npm run docs` lists every Building Block, and `npm run docs <Block>` prints one block's README. The `Pipeline` CI/CD construct is documented in the [`@aws-cdk-blocks/pipeline` README](../pipeline/README.md).

## Local Development

In local dev mode, Building Blocks use mock implementations. No AWS resources needed.

The dev server (`npm run dev`) listens on `127.0.0.1` (loopback) only, so nothing on your network can reach it. It serves your whole API against the local mock data, and local auth authenticates nothing. In a container or a remote devbox where you control who can reach the port, opt into a wider interface:

```bash
BLOCKS_DEV_HOST=0.0.0.0 npm run dev   # prints a warning: anyone who can reach this interface can call your API
```

Set the host with `BLOCKS_DEV_HOST`, `npm run dev -- --host <host>` or `"host"` in `package.json#blocks.dev`; the dev task exports the last two to the dev server as `BLOCKS_DEV_HOST`. Passing `host` to `startDevServer({ host })` when you call it yourself changes only the interface it binds; set `BLOCKS_DEV_HOST` too to opt `/realtime` in.

- With a wildcard (`BLOCKS_DEV_HOST=0.0.0.0`), open the app by IP address (e.g. `http://192.168.1.10:3000`). Requests and same-origin pages reached by IP are accepted; DNS names are not (the dev server answers them `403`).
- To open it by hostname (e.g. `http://mybox.example.com:3000`), set `BLOCKS_DEV_HOST=mybox.example.com` instead.
- Behind a reverse proxy or a port-forwarding tunnel that passes its own public hostname in `Host` (a cloud-IDE forwarded-port URL, or nginx with `proxy_set_header Host $host`), configure the proxy to rewrite `Host` to `localhost:<port>`. `BLOCKS_DEV_HOST` is also the address the dev server binds, so setting it to a name that only exists in front of the proxy makes the dev server fail to start.

### Request checks

The dev server refuses requests that another site could trigger:

- **`Host`.** Every request gets `403 Forbidden` unless its `Host` header names `localhost`, `127.0.0.1`, `[::1]` (with any port) or the host you configured.
- **`Origin`.** A `POST`, `PUT`, `PATCH` or `DELETE` request (JSON-RPC calls and RawRoutes alike) whose `Origin` header names another site gets `403 Forbidden`.
  - Allowed origins: a loopback origin on any port (`http://localhost:5173`, `http://127.0.0.1:3100`, `http://[::1]:4321`), which includes any other app running on your own machine; the dev server's own address (a page opened by IP address with `BLOCKS_DEV_HOST=0.0.0.0`); and the host set in `BLOCKS_DEV_HOST` (or `startDevServer({ host })`) on any port.
  - `Origin: null` is refused.
  - Not checked: a request with no `Origin` header, such as `curl`, server-side rendering or a native client, and `GET`, `HEAD` and `OPTIONS` requests.
  - To call the dev server from a page on another hostname, set `BLOCKS_DEV_HOST` to that hostname; there is no separate allowed-origin list for local dev (`defaults.allowedOrigins` applies to the deployed API).
- **`Content-Type`.** A JSON-RPC call (`POST /cdk-blocks/api`) must send `Content-Type: application/json` (parameters such as `; charset=utf-8` are fine), or it gets `415 Unsupported Media Type` and the method doesn't run, even when no `Origin` is sent. The generated client and the Swift, Kotlin and Dart clients send `application/json`; with `curl`, pass `-H 'Content-Type: application/json'`. RawRoutes accept any content type.

The `Origin` and `Content-Type` checks apply in local mode and in sandbox mode, where the dev server forwards API requests to the deployed sandbox API (`BLOCKS_API_URL`): a refused request is never forwarded.

Two local endpoints have their own rule:

- `/cdk-blocks/settings` opens `.cdk-blocks/local/data/settings.json` in your editor only for a request you made yourself (typed into the address bar or followed from your app, including a frontend served on another `localhost` port); a request another site triggers gets `403`.
- The realtime WebSocket (`/realtime`) accepts upgrades only from loopback origins, or from the host in `BLOCKS_DEV_HOST`. Only server-side `Realtime.publish()` can publish. Clients can subscribe, but not publish, as in a deployed app.

### Generated client

At startup the dev server regenerates `cdk-blocks/client.js` from your backend. An app that ships its own client turns that off with `"generateClient": false` in `package.json#blocks.dev`, or with `startDevServer({ generateClient: false })`, as the `amplify` overlay does:

```json
{ "blocks": { "dev": { "port": 3001, "frontend": false, "generateClient": false } } }
```

## Script output (`BLOCKS_LOG_LEVEL`)

The lifecycle scripts in `@aws-cdk-blocks/core/scripts` (`deploy`, `destroy`, `startSandbox`, `destroySandbox`, `startDevServer`, which the generated `npm run deploy` / `sandbox` / `sandbox:destroy` / `destroy` / `dev` scripts call) read the `BLOCKS_LOG_LEVEL` environment variable to decide how much to print:

| `BLOCKS_LOG_LEVEL` | What prints |
|---|---|
| unset (or any other value) | Everything: every progress step and the raw CDK output, as at `verbose`, plus the dev server's RPC error stack traces. |
| `quiet` | Errors and final results only. CDK output is hidden while it runs. |
| `normal` | Short progress steps and results. CDK output is condensed into a few lines (`Synthesizing app...`, a resource count); failure and rollback lines still print as they happen. |
| `verbose` | The same lines as unset: every progress step plus the raw CDK output (the dev server leaves out RPC error stack traces, see below). |
| `debug` | `verbose` plus stack traces for errors the scripts catch and report as warnings. |

```bash
BLOCKS_LOG_LEVEL=normal npm run deploy
```

No level hides the lines other tools read: the deployment-target summary, the `API URL` / `Frontend URL` lines, the early `🌐 Frontend deploying to:` line, the `BLOCKS_DEPLOYED …` line, and error messages.

At `quiet` and `normal` the scripts keep the last 500 lines of the hidden CDK output (`cdk synth`, `cdk deploy`, `cdk destroy`, `cdk watch`). If the deploy or destroy fails, they print those lines to stderr under a `──── cdk deploy output (…) ────` header before the error. `cdk watch` prints them when a watch deploy fails or `cdk watch` exits with an error.

In the dev server, `quiet` and `normal` hide the per-call `[rpc-in]` / `[rpc-call]` / `[rpc-ok]` lines but keep the `[rpc-err]` and `RawRoute Error:` lines (name, message and `cause`); the stack trace prints when `BLOCKS_LOG_LEVEL` is unset or `debug`. `BLOCKS_DEV_QUIET=1` still hides all of those lines at every level.

## CORS Configuration

By default the API sends no `Access-Control-Allow-Origin` header. Allowed origins come from two places: the stack's `defaults.allowedOrigins` (plain origins or regex patterns; every CDK Blocks compute receives them as the `CORS_ALLOWED_ORIGINS` environment variable) and, when you use `Hosting`, the front door's own URL (registered automatically as `CORS_HOSTING_ORIGINS`).

### `allowedOrigins` entries

Each entry in `defaults.allowedOrigins` is one of:

- **A plain origin** — `scheme://host[:port]`, such as `'https://app.example.com'` or `'http://localhost:3000'`.
  - It is matched exactly and case-insensitively; its dots are literal, so `https://appxexample.com` does not match.
  - A trailing `/` is ignored.
  - An `http`/`https` origin is compared in the form the browser sends: the default port is dropped (`'https://app.example.com:443'` matches `https://app.example.com`) and an internationalized host is converted to punycode (`'https://bücher.example'` matches `https://xn--bcher-kva.example`).
  - Rejected: user info (`user@`), a path (anything after the host and port other than a single trailing `/`), a query, a fragment, and a host with characters other than letters, digits, `.` and `-` (or a bracketed IPv6 address).
- **A regex pattern** — any entry with regex syntax (`^`, `$`, `\`, `(`, `|`, `*`, ...).
  - It is anchored as `^(?:<entry>)$` and matched case-sensitively. The entry must compile on its own.
  - Escape every dot (`'https://app\\.example\\.com'`) unless it is followed by a quantifier, as in `'.*'`.
  - Glob wildcards such as `'https://*.example.com'` are not supported. To allow any subdomain, use a pattern such as `'https://[a-z0-9-]+\\.example\\.com'`.
  - Brace quantifiers are limited to `{n}`: `{n,}` and `{n,m}` contain a comma, and entries are comma-joined into `CORS_ALLOWED_ORIGINS`.
  - A group repeated with `*`, `+` or `{n}` that itself contains a repeating quantifier or an alternation (such as `'(a+)+'`, `'([a-z]+\\.)*'` or `'(a|b)+'`) is not supported, because such patterns can make matching very slow; this check does not rule out every slow pattern. To allow subdomains at any depth, use `'https://[a-z0-9.-]+\\.example\\.com'` instead of `'https://([a-z0-9-]+\\.)*example\\.com'`.

`BlocksStack.create()` and `BlocksBackend.create()` reject an entry that breaks these rules, so `cdk synth` fails with a message naming the entry. If one still reaches the runtime, it is ignored and logged.

### When using Hosting (recommended)

With `Hosting` and its `api` prop (a `BlocksStack` or `BlocksBackend`), no CORS configuration is needed:

- Requests through the front door's proxy at `/cdk-blocks/api` are same-origin.
- Direct cross-origin calls from the frontend to the API Gateway URL are allowed too: `Hosting` registers the front door's URL (the CloudFront distribution's domain, your custom domain, or another door's address) as an allowed origin, separately from `defaults.allowedOrigins`.

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

If your frontend is hosted on a different domain (e.g., Vercel, Netlify), list its origins in the stack's `defaults.allowedOrigins`:

```typescript
defaults: {
  ...BlocksPresets.production,
  allowedOrigins: ['https://myapp.com', 'https://staging.myapp.com'],
},
```

Each entry is a plain origin, matched exactly, or a regex pattern, anchored as `^(?:<entry>)$`; [`allowedOrigins` entries](#allowedorigins-entries) has the rules and what fails synth. The two entries above are plain origins. Regex examples:

| Pattern | Matches |
|---------|---------|
| `https://myapp\\.com` | Exact match for `https://myapp.com` |
| `https://.*\\.myapp\\.com` | Any subdomain of `myapp.com` |
| `^https?://(localhost\|127\\.0\\.0\\.1)(:\\d+)?$` | Localhost/127.0.0.1, any port, http or https (sandbox) |
| `.*` | All origins: any site can call the API from a browser. Use it only on purpose. |

> **Regex entries.** In a regex entry an unescaped `.` matches *any* character, so synth rejects one that is not followed by a quantifier: write `https://app\\.example\\.com`. Because the anchors wrap the whole expression, every branch of a top-level `|` alternation is anchored too. Prefer separate entries over one `|`-joined entry for readability. The CloudFront origin the `Hosting` construct injects for you is always escaped and anchored automatically.

If an origin doesn't match any pattern, the handler omits the `Access-Control-Allow-Origin` header (browser blocks the response) and logs a `[CORS]` warning to CloudWatch.

## Committed baselines (`cdk-blocks/baselines/`)

Some Building Blocks refuse a destructive change at synth by comparing it with a baseline file they write into your app: `cdk-blocks/baselines/<stack>/<file>.json`, next to the backend handler file the stack was created with. `Auth` writes one: it records the user-pool settings that Cognito cannot change after the pool exists.

- **Commit these files.** The check only protects a synth that sees them; a fresh checkout without them starts a new baseline from whatever the configuration is now.
- **Renaming or removing a block** whose baseline says it owns a stateful resource fails synth on every `BlocksStack` / `BlocksBackend`, even when the block's package is no longer imported. The message names what CloudFormation would delete and the re-baseline variable to set if the removal is intended.
- **The format is versioned.** Every file has a top-level `version` (currently `1`; a file without one is read as `1`), a `fullId` naming the block that owns it, and, while that block owns a stateful resource, a `removalGuard`. The rest of the file belongs to the block that wrote it.
  - A `version` higher than the installed release knows fails synth: upgrade `@aws-cdk-blocks/core` and `aws-cdk-blocks`.
  - A `version` that is not a whole number from 1 fails synth as invalid: restore the file from version control.
  - CDK Blocks never rewrites or deletes such a file.

## IAM: permissions boundary and the composed-policy report

Every CDK Blocks compute (the API handler, raw routes, queue/cron/WebSocket handlers, the agent runtime) runs as one shared execution role, and every Building Block grants its permissions onto that role.

### See what the role holds: `<stack>.blocks-iam.json`

Every synth writes a report of the shared role's composed policy next to the template in `cdk.out/`: `<stackName>.blocks-iam.json` for a `BlocksStack`, or `<stackName>.<backendId>.blocks-iam.json` for each embedded `BlocksBackend`. It holds:

- `executionRole.statements`: every statement (`actions`, `resources`, `condition`), each with a `blocks` field: the `fullId`s of the Building Blocks that own the resources it references.
- The managed policies and the boundary in force.
- `roles`: every IAM role CDK Blocks created, each with its boundary and tags exactly as the template carries them.

The file is sorted and deterministic, so a CI step can diff it against the previous build and fail when an app's permissions grow unexpectedly:

```bash
NODE_OPTIONS="--conditions=cdk" npx cdk synth --quiet
jq '.executionRole.statements[] | {actions, blocks}' cdk.out/my-app.blocks-iam.json
```

The report is a side file, written whether or not `permissionsBoundary` is set. It is not part of any CloudFormation template and is not listed as a cloud-assembly artifact in `cdk.out/manifest.json`, so it is not deployed and `cdk diff` does not show it.

### When the role's grants outgrow its inline policy

Grants land on the role's inline default policy, which IAM caps at 10,240 characters. When an app's grants go past that, synth still succeeds: CDK packs the overflow into managed policies (sized to stay under IAM's 6,144-character limit) attached to the role. Blocks keep calling `grant*()` as before.

To fit more grants into fewer policies, the role's statements are merged before they are packed. Merging combines statements with the same effect and conditions (and no `Sid`, `NotAction` or `NotResource` differences) that share their actions or their resources. It never combines both lists at once, so no permission is added. The role's policy is merged at every size, so the template doesn't switch back and forth as grants are added.

CDK fills the default policy and the overflow policies in order, so adding or removing a grant can move statements from one policy to another, and CloudFormation updates those policies in parallel ([aws/aws-cdk#35611](https://github.com/aws/aws-cdk/issues/35611)). So that a deploy doesn't remove a statement from its old policy before its new policy is attached, each overflow policy gets a logical ID derived from its contents (`BlocksOverflowPolicy<hash>`), and the role's default policy depends on them. A changed overflow policy is created as a new resource before the default policy is updated, and the old one is deleted in CloudFormation's cleanup phase. Overflow policies whose statements didn't change keep their logical IDs. IAM is eventually consistent, so a newly attached policy can still take a few seconds to apply. Because the default policy depends on every overflow policy, making a resource depend on one specific grant to the execution role (for example `grant.applyBefore()`, a grant's `policyDependable`, or constructs such as AgentCore Memory given the execution role) while the role is also granted access to that resource can make CloudFormation report a circular dependency. To fix it, make the resource depend on the whole role, or use a separate role for it.

IAM also limits how many managed policies one role can carry: 20 by default, up to 25 with a quota increase. If the role's grants were packed into overflow policies and the role then needs more managed policies than that, synth fails with an error naming the role and the Building Blocks that grant the most. To fix it, consolidate resources where possible, or move some Building Blocks into a separate CDK Blocks backend (another `BlocksStack` / `BlocksBackend`), which has its own execution role. If the account's "Managed policies per role" quota was raised, set it in `cdk.json`:

```json
{ "context": { "@aws-cdk-blocks/core:managedPoliciesPerRoleQuota": 25 } }
```

The check counts the policies the role carries after the deploy. During a deploy that changes overflow policies, the role briefly carries both the old and the new copy of each changed one, so a role at or close to the quota can fail that deploy in CloudFormation; keep some room below the quota. Synth warns when the role is within the quota but a deploy that replaces every overflow policy would exceed it.

Overflow statements appear in `<stack>.blocks-iam.json` like any other, with `policy` naming the managed policy they were packed into.

### Cap every role: `defaults.permissionsBoundary`

`defaults.permissionsBoundary` attaches a [permissions boundary](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) to every IAM role CDK Blocks creates: the shared execution role, block-owned helper roles, the CDK custom-resource roles blocks cause, and `Hosting`'s roles (including the Lambda@Edge and CloudFront-monitoring roles in the separate `us-east-1` stacks). A role's effective permissions are the intersection of its policies and the boundary.

```typescript
// cdk-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' },
});
```

Pass the policy's name (resolved in the deploying account), its full ARN (required when the policy has a path), or an `iam.IManagedPolicy`. The option is unset in both presets, and unset leaves templates unchanged.

- **Scope.** On a `BlocksStack` the boundary covers every role in the stack. On an embedded `BlocksBackend` it covers the backend's subtree plus the stack-level CDK singleton roles its blocks add; roles your stack already had are left alone. Bound those, and any other stack, yourself with `iam.PermissionsBoundary.of(stack).apply(policy)`.
- **With CDK's `@aws-cdk/core:permissionsBoundary` context.** The context bounds every role in the app. When both are set, `defaults.permissionsBoundary` wins for the roles CDK Blocks creates and synth warns. Set the context in `cdk.json` (the `-c '@aws-cdk/core:permissionsBoundary={"name":"…"}'` CLI form passes a string, which CDK ignores). The context doesn't reach the cross-region-reference provider roles CDK adds while preparing the app, such as the ones off-region `Hosting` causes; `defaults.permissionsBoundary` does.
- **What it doesn't do.** A boundary caps the shared role; it doesn't split it. Every handler still runs as the same role, so a bug in one block can still use another block's grants, up to the boundary. Separately deployed apps that need isolation from each other belong in separate AWS accounts.

### Running many apps in one AWS account (a shared platform)

For platforms that deploy many independently written apps through one pipeline into one AWS account. Each app's CDK code decides the permissions of its own roles, and nothing in the app stops it from granting itself another app's resources: a single `AppSetting.fromExisting(scope, 'x', { name: '/appb-db-password', secret: true })` gives App A read access to App B's secret, and the deploy succeeds.

The strongest isolation is one AWS account per app (AWS Organizations with SCPs). When apps must share an account, the platform enforces a per-app ceiling with IAM, outside the apps' code. CDK Blocks provides the app side of it with one option, `defaults.appIdentity`. The platform team writes and owns the IAM policies; [SHARED-ACCOUNT.md](./SHARED-ACCOUNT.md) documents what they contain:

| Part | Who provides it | How |
|---|---|---|
| 1. An identity on everything the app creates | CDK Blocks | `defaults.appIdentity: { id }` tags every resource and role `app=<id>`, and every name it derives starts with `<id>-` |
| 2. A boundary on every role the app creates | CDK Blocks | `defaults.permissionsBoundary` |
| 3. The boundary policy, shared by every app | The platform | [The shared permissions boundary](./SHARED-ACCOUNT.md#the-shared-permissions-boundary) |
| 4. A CloudFormation execution policy, shared by every app, so each app's execution role only creates bounded roles tagged as the app | The platform | [The shared execution policy](./SHARED-ACCOUNT.md#the-shared-execution-policy) |
| 5. A deploy guard, shared by every app, that keeps each app's deploy role on its own stacks | The platform | [The deploy guard](./SHARED-ACCOUNT.md#the-deploy-guard) |
| 6. A pipeline step before credentials are issued | The platform | [The pipeline](./SHARED-ACCOUNT.md#the-pipeline): synth, which fails on any violation, and the report's `app.id` |

**1–2. In each app.** Name the stack after the app id, and set the identity and the boundary:

```typescript
// cdk-blocks/index.cdk.ts — the app id comes from the platform's pipeline, not the app's code
export const blocksStack = await BlocksStack.create(app, process.env.APP_ID!, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...BlocksPresets.production,
    appIdentity: { id: process.env.APP_ID! },
    permissionsBoundary: 'apps-boundary',
  },
});
```

- **The id** is 1–10 lowercase letters and digits, starting with a letter, with no hyphen. It is also the app's CDK bootstrap qualifier, so every app has its own bootstrap. Synth rejects a reserved id, saying why; however the platform hands out ids, it should reject them too:
  - `cdk`, `blocks`, `secrets`, `config`, `amplify`, `cf`, `sagemaker`;
  - the region prefixes `af`, `ap`, `ca`, `cn`, `eu`, `eusc`, `il`, `me`, `mx`, `sa`, `us`;
  - any id starting with `aws` or `ssm`.
- **Names.** Name the stack `<id>` or `<id>-…`: every name then starts with `<id>-`. Every Building Block derives its resource names (tables, queues, buckets, parameters, schedules, user pools) from its `fullId`, which starts with the stack's id, and CloudFormation-generated names (functions, roles, topics, alarms, managed policies) start with the stack name. Developers don't name anything themselves. CDK Blocks also names the Lambda layers (`<id>-<logical id>`) and the CloudFront Functions and KeyValueStores (`<id>-<region>-…`) it creates, unless the app chose a name itself.
- **Hosting `secret()` and `config()`.** Their values are named `blocks/<stackId>/secrets/…` (Secrets Manager) and `/blocks/<stackId>/config/…` (SSM), where `stackId` comes from `.cdk-blocks/config.json`. Under `defaults.appIdentity`, set `stackId` to the app id: the boundary allows `blocks/<id>/…` by name, so the values `npm run secret` / `npm run config` create untagged still work, and the IAM report treats any other `blocks/…` name as outside the app, with a hint to fix `stackId`.
- **Tags.** `app=<id>` goes on every resource CloudFormation creates for the app and every IAM role CDK Blocks creates, including the CDK custom-resource provider roles. It also goes on `Hosting` and on the separate stacks Hosting adds (the `us-east-1` CloudFront alarm stack `<id>-CfMonitoring-…` and the Lambda@Edge stack `<id>-edge`), as a stack tag too. An app can still remove the tag; the execution role (part 4) rejects any role not tagged `<id>`. SecureString parameters that CDK Blocks' secret initializer creates at deploy time carry only the `aws-blocks-stack` tag; SSM is scoped by name.
- **The IAM report** (`cdk.out/<stack>.blocks-iam.json`) gains an `app` section and a `violations` list. Synth fails on any violation. With `reportOnly: true`, synth only writes the report and prints a one-line summary, for example while adopting `appIdentity` in an existing app.

| Violation | Details |
|---|---|
| A role without the boundary or the app tag | |
| A grant on a name outside the app's prefix | For example `fromExisting` on another app's parameter, or another app's table, queue, bucket, function, layer, RDS cluster or vector bucket. Only SSM parameters may also be named `<id>` or `<id>/…`. |
| A name-fenced resource the app itself names outside its prefix | A table, queue, bucket, function, layer, parameter, log group, RDS cluster or instance, vector bucket, event rule or bus, schedule, secret or state machine. The execution policy would refuse to create it. |
| A wildcard grant on a data service | A grant on `*` or on a resource name that starts with `*`. The services: SSM, DynamoDB, SQS, S3, Secrets Manager, Lambda, CloudWatch Logs, Step Functions, Cognito, EventBridge and EventBridge Scheduler, KMS, API Gateway, SNS, SES, RDS and its Data API, Aurora DSQL, Bedrock, Bedrock AgentCore, S3 Vectors, ECS, CloudFront KeyValueStores, and IAM and STS for passing or assuming a role. |
| An "everything except" grant | `NotAction`, `NotResource`. |
| A resource the check can't resolve | `Fn::Sub` on a parameter, `Fn::ImportValue`, a template parameter. These fail closed. |
| A resource policy that opens up another app's resource, or that lets in someone who isn't this app | Everyone, another account, another app's role, `NotPrincipal`, or a public Lambda function URL, in a Lambda or layer permission or a bucket, queue, topic, secret, KMS key or replica key, REST API or EventBridge bus policy, in any of the app's stacks. A policy the check can't read (an intrinsic, a string) fails closed. |
| A role that trusts anything but an AWS service | |
| A broad AWS managed policy | `AdministratorAccess`, `*FullAccess`. |
| The CDK asset bucket of another bootstrap | |
| `api-outside-app` | A grant on a literal API id, or an API Gateway stage, route or deployment attached to an API that isn't in the app's own template. |
| A stack or block outside the prefix | |

Not violations:

- Three wildcard grants Building Blocks make: model invocation on AWS-owned Bedrock foundation models and system-defined inference profiles (no app's data), an Agent invoking AgentCore runtimes (the boundary caps it to runtimes tagged as the app), and SES sending (an exception listed under Limits in [SHARED-ACCOUNT.md](./SHARED-ACCOUNT.md)).
- In a resource policy: a service, the app's own roles and the account's root. Everyone is accepted only on a public REST API, or when a condition pins it to the app's own ARNs in this account (`aws:SourceArn`, `aws:PrincipalArn`) or to `aws:PrincipalTag/app` together with `aws:PrincipalAccount` (the caller's own account sets its tags, so the tag alone isn't enough).

The report reads grants on the services listed above (and an IAM role's name, for `iam:PassRole` and `sts:AssumeRole`); it doesn't read grants on other services, such as Kinesis, Firehose, ECR, OpenSearch or Glue, so a clean report isn't full coverage. A service the boundary doesn't list is still denied at runtime. The report and the synth failure are fast feedback for developers and their agents. They aren't the boundary: the app's own code runs at synth, so a determined app could get around them. The boundary is IAM, in parts 3–5.

**3–5. The platform's policies**, the pipeline (part 6), the project template, and adopting `defaults.appIdentity` in an existing app are in [SHARED-ACCOUNT.md](./SHARED-ACCOUNT.md).

### Service-principal trust: `aws:SourceAccount` and `aws:SourceArn`

Every IAM role CDK Blocks creates that an AWS service assumes (other than Lambda execution roles) limits that trust to the stack's account and to resources of that service, with an `aws:SourceAccount` (`StringEquals`) and an `aws:SourceArn` (`ArnLike`) condition. Synth checks this on the same set of roles `defaults.permissionsBoundary` covers:

- **Roles CDK Blocks creates** — under a CDK Blocks Building Block or a compute, the backend's own roles, and the stack-level roles a block creates on its behalf (custom-resource providers, `Hosting`'s). A trust without either condition fails synth, naming the role's construct path and the principal.
- **Roles your app creates** — every other covered role: your own constructs in the backend module (on the `BlocksStack` or embedded `BlocksBackend`, at stack scope, or under a `Scope` namespace), roles you add to a `BlocksStack` after `BlocksStack.create()`, roles inside a custom Building Block you write (a `Scope` subclass, see [Pattern 3: Custom BB](https://github.com/aws/cdk-blocks/blob/main/docs/guides/extending-with-existing-aws-resources.md#pattern-3-custom-bb)), and the roles CDK creates inside any of these (for example the `EventsRole` of an `events.Rule` that targets a state machine). A trust without either condition gets a synth warning, and the deploy goes ahead.

A condition counts only under an operator that requires the key and with a value that names an account. The KMS key-policy check below uses the same rules.

- Operators that count: `StringEquals`, `StringEqualsIgnoreCase`, `StringLike`, `ArnEquals`, `ArnLike`, and their `ForAnyValue:` forms.
- Operators that do not count: an `…IfExists` operator, a negated operator (`StringNotEquals`, `ArnNotLike`, …), `Null`, a `ForAllValues:` operator.
- Values that do not count: `*` alone, an `aws:SourceAccount` with a wildcard, an `aws:SourceArn` whose account segment is empty or a wildcard.
- A value built from tokens is read by its literal parts: `arn:${stack.partition}:cloudwatch:*:*:alarm:*` does not count, while a value that starts with a token and has no literal account segment (such as `${topic.topicArn}/*`) counts.

Not checked:

- Lambda execution roles (`lambda.amazonaws.com`, `edgelambda.amazonaws.com`).
- The `apigateway.amazonaws.com` trust of an API Gateway CloudWatch Logs role: any role that an `AWS::ApiGateway::Account` in the same stack names as its `cloudWatchRoleArn`. That includes the stack-level `BlocksApiGatewayCloudWatchRole` CDK Blocks creates when access logging is on, and the `cloudWatchRole` a CDK `apigateway.RestApi` creates by default. API Gateway does not send `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with that role, so either condition stops log delivery. Any other principal on that role, and `apigateway.amazonaws.com` on any other role, is still checked.

**Resolving the warning.** Add both conditions to the trust statement. For a role you create, pass them as the principal's `conditions`. For a role a CDK construct creates with no prop for its trust, set them on the role's CloudFormation resource with a property override; the warning names the statement index (`N`). Do not condition an API Gateway CloudWatch Logs role: name it as the `cloudWatchRoleArn` of an `apigateway.CfnAccount`, which the check accepts, or acknowledge the warning.

```ts
// `machine` is an sfn.StateMachine that an events.Rule targets. The EventsRole the target
// created trusts events.amazonaws.com in statement 0.
// (A pattern, not rule.ruleArn: the rule already references this role.)
const eventsRole = machine.node.findChild('EventsRole').node.defaultChild as cdk.CfnResource;
eventsRole.addPropertyOverride('AssumeRolePolicyDocument.Statement.0.Condition', {
  StringEquals: { 'aws:SourceAccount': stack.account },
  ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:events:${stack.region}:${stack.account}:rule/*` },
});
```

**Acknowledging it.** To keep a trust as it is, acknowledge the warning id `@aws-cdk-blocks/core:serviceRoleTrustWithoutSourceCondition`, on the role or on any construct above it (the stack acknowledges it for every role in the stack):

```ts
cdk.Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/core:serviceRoleTrustWithoutSourceCondition');
```

**KMS key policies.** The same check reads the key policy of every `AWS::KMS::Key` in the same set of scopes. An `Allow` statement that names an AWS service principal must carry one of:

- `aws:SourceAccount` or `aws:SourceArn` ([AWS global condition keys in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/conditions-aws.html)); either one is enough;
- for CloudWatch Logs (`logs.<region>.amazonaws.com`, or `.amazonaws.com.cn`), `kms:EncryptionContext:aws:logs:arn` ([Encrypt log data in CloudWatch Logs using AWS KMS](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html)).

The operators and values that count are the same as for roles. `aws:SourceOrgID` and `aws:SourceOrgPaths` don't count, because they admit every account in the organization. `kms:ViaService` doesn't count either: it applies when an IAM principal calls through a service, and a service principal's own requests don't carry it.

One principal is exempt: `events.amazonaws.com`, in a statement that grants only `kms:GenerateDataKey*` and `kms:Decrypt`. Amazon SNS documents that `aws:SourceAccount`, `aws:SourceArn` and `aws:SourceOrgID` in a key policy aren't supported for EventBridge publishing to an encrypted topic ([Enable compatibility between event sources from AWS services and encrypted topics](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html#compatibility-with-aws-services)), so either condition stops delivery.

As with roles, a key CDK Blocks creates fails synth, naming the key's construct path, the principal and the statement index; a key your app creates gets a synth warning with the id `@aws-cdk-blocks/core:kmsKeyPolicyWithoutSourceCondition`, which you acknowledge the same way:

```ts
cdk.Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/core:kmsKeyPolicyWithoutSourceCondition');
```

Other resource policies and KMS grants aren't checked.
