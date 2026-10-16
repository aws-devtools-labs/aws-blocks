# @aws-blocks/hosting

Low-level CDK L3 constructs for deploying web applications on AWS
(CloudFront, S3, Lambda, WAF, monitoring, DNS).

## Overview

This package provides:

1. **`HostingConstruct`** -- a CDK L3 construct that provisions a full hosting
   stack (CloudFront distribution, S3 origin, Lambda compute, optional WAF,
   monitoring dashboards, and DNS records).

2. **Framework adapters** (Next.js, Nuxt, Astro, SPA) that run the framework
   build, produce a `DeployManifest`, and hand off to the construct for
   provisioning.

3. **Manifest types** (`DeployManifest`, `RouteBehavior`, `ComputeResource`,
   etc.) that describe the shape of a deployment.

## When to use this package directly

Most users should use `Hosting` from `@aws-blocks/core`, which wraps these
constructs with the AWS Blocks integration layer (route registry, config.json
generation, RPC prefix wiring).

Use `HostingConstruct` directly when you need:

- A standalone CDK app without the AWS Blocks layer
- Fine-grained control over construct props
- Custom adapters or manifest generation pipelines

## Main exports

```ts
// Root entry point: the CDK-free value API (safe to import in SSR/runtime code)
import { secret, config, getSecret, getConfig } from '@aws-blocks/hosting';

// Sub-path: the construct, manifest types, and the CDK resolution engine
import {
  HostingConstruct,
  HostingConstructProps,
  HostingDomainConfig,
  HostingWafConfig,
  generateBuildId,
  DeployManifest,
  RouteBehavior,
  ComputeResource,
  FrameworkAdapterFn,
  HostingError,
} from '@aws-blocks/hosting/constructs';

// Sub-path: adapters only
import { nextjsAdapter, nuxtAdapter, astroAdapter, spaAdapter } from '@aws-blocks/hosting/adapters';

// Sub-path: typed errors
import { HostingError } from '@aws-blocks/hosting/error';
```

> The value API is on the bare `@aws-blocks/hosting` entry so an SSR/runtime bundle
> can import `getSecret`/`getConfig` without pulling in CDK. The construct and the
> resolution engine live on `/constructs`.

## Secrets & config

Keep sensitive and environment-specific values out of source. You declare a value
by **which function you call** — that choice picks the store, and the framework
owns everything else (the CLI write, the IAM grant, the runtime read):

| Declare (infra) | Store | Read (runtime) |
| --- | --- | --- |
| `secret('KEY')` | AWS **Secrets Manager** (sensitive) | `getSecret('KEY')` |
| `config('KEY')` | AWS **SSM Parameter Store** (non-sensitive, free tier) | `getConfig('KEY')` |

### Declare — in your hosting infra

```ts
import { HostingConstruct } from '@aws-blocks/hosting/constructs';
import { secret, config } from '@aws-blocks/hosting';

new HostingConstruct(stack, 'Web', {
  manifest, // produced by a framework adapter (see "Main exports")
  environment: {
    STRIPE_KEY: secret('STRIPE_KEY'), // → Secrets Manager
    FEATURE_FLAGS: config('FEATURE_FLAGS'), // → SSM Parameter Store
  },
  // Optional per-kind namespace / cache config:
  secretStore: { prefix: '/myapp/secrets' },
  configStore: { prefix: '/myapp/config', cacheTtlSeconds: 30 },
});
```

The marker is inert (`{ key, kind }`) and safe to commit — only the store
*locator* is injected (never the value), and the compute role is granted
least-privilege read on that one resource (`secretsmanager:GetSecretValue` /
`ssm:GetParameter`, scoped to the exact ARN) plus `kms:Decrypt`.

Markers in `environment` are wired for **runtime** resolution (above), so both
`secret()` and `config()` are allowed there (only the locator is injected, never
the value). Resolving a marker to a literal at **synth time** — e.g. for
`domain.domainName`, which must be a literal before CloudFront/ACM are built —
**inlines the value into the CloudFormation template**, so those positions accept
only `config()` (non-sensitive → SSM) or a plain string, never `secret()`. Synth
resolution needs an async wrapper that does the SDK read during construction; that
path is provided by the Blocks `Hosting` block (`await Hosting.create(...)`), not
this leaf construct, whose `domain.domainName` is a plain `string | string[]`.

**Bring your own:** `environment` also accepts an existing CDK `ISecret` /
`IParameter` handle — the construct grants read via the handle and injects its
locator, so `getSecret` / `getConfig` resolve it identically (managed
*provisions*, BYO *references*).

### Read — in your SSR / API / runtime code

```ts
// The value API is the bare entry (CDK-free), so no CDK is pulled into the runtime bundle:
import { getSecret, getConfig } from '@aws-blocks/hosting';

const key = await getSecret('STRIPE_KEY'); // Secrets Manager
const flags = await getConfig('FEATURE_FLAGS'); // SSM
```

Each getter reads `process.env.KEY` first, so **local dev needs no AWS** — put
the value in a `.env` file. On a deployed function it fetches + decrypts from its
store and caches per cold start (or per `cacheTtlSeconds`, for rotation without a
redeploy).

### Type-safe keys — autocomplete + typo errors, zero code

By default `getSecret` / `getConfig` accept any `string`. Run `hosting-typegen`
(wire it as `"typegen": "hosting-typegen"` and, ideally, a `"predev"` hook) to make
them **type-safe with no call-site change**:

```bash
npx hosting-typegen           # scan secret()/config() calls → .blocks/hosting-values.d.ts
npx hosting-typegen --watch   # regenerate on every save (run alongside your dev server)
npx hosting-typegen --check   # CI: fail if that file is stale
```

**In a Blocks app you get this for free** — the Blocks dev server (`npm run dev`)
auto-detects `secret()`/`config()` usage and runs the generate-and-watch step itself,
so keys update as you type with no second command. (It's a no-op if the app declares
no secrets, and never blocks the dev server.) For a standalone hosting app, run
`hosting-typegen --watch` alongside your dev server, or add a `"predev"` hook. Either
way, add `hosting-typegen --check` in CI to catch a stale committed file.

It statically scans your `secret('...')` / `config('...')` calls (no app execution,
no AWS credentials) and generates a `.d.ts` that narrows the getters to exactly your
declared keys — so a typo, or reading a `config` key with `getSecret` (the wrong
store), is a **compile error**, and your editor autocompletes the valid keys:

```ts
await getSecret('STRIPE_KEY'); // ✅ declared with secret()
await getSecret('STRIPE_KYE'); // ❌ compile error — not a declared secret key
```

Add the generated file to your `tsconfig.json` `include` and let the tool own it
(it is regenerated, never hand-edited):

```jsonc
{ "include": ["src", "aws-blocks", ".blocks/**/*.d.ts"] }
```

The keys come straight from your `secret()`/`config()` calls — the single source of
truth — so the types can't drift from what you wired. The file is safe to delete
(the keys just fall back to `string`) and safe to `.gitignore` and regenerate.
Because it is derived only from string-literal keys, a `secret(myVar)` with a
non-literal key is reported and skipped; and a synth-only `domain` / `connectionArn`
key may appear in autocomplete even though it is not readable at runtime.

### Typed, parsed values with a schema

Pass a schema (Zod, Valibot, ArkType — any Standard Schema) to get a **typed,
parsed** value instead of a `string`:

```ts
// declare
import { z } from 'zod';
environment: { FEATURE_FLAGS: config('FEATURE_FLAGS', { schema: z.object({ beta: z.boolean() }) }) }

// read — no JSON.parse, no `any`
const { beta } = await getConfig('FEATURE_FLAGS');   // typed as { beta: boolean }
```

`typegen` infers the schema's output type (via a TypeScript `Program`) and inlines
it into the generated `.d.ts`, so `getConfig`/`getSecret` **return that type**. At
runtime the value is JSON-parsed automatically (a per-key flag is set at synth). The
schema type is typed as `StandardSchemaV1`, so the library is your choice. Note this
is parse-to-type: the schema object isn't shipped to the runtime (it can't cross the
synth→runtime bundle boundary), so it parses to the declared type rather than
deep-re-validating on read.

### Transport markers across a JSON / build boundary

A marker is branded with a `Symbol` (and may carry a non-serializable `schema`), so
it does **not** survive a plain `JSON.stringify` → `JSON.parse`: the brand is dropped
and `isManagedValue()` returns `false` on the far side. If you carry a config object
containing markers across a JSON boundary — e.g. an orchestrator that serializes
per-stage config into a build **environment variable** and reads it back in a later
build phase — use the codec for a lossless round-trip:

```ts
import {
  managedValueReplacer,
  managedValueReviver,
  encodeManagedValue,
  decodeManagedValue,
  isManagedValueJSON,
  ManagedValueCodecError,
} from '@aws-blocks/hosting';

// Producer (phase 1): stringify with the replacer, stash in an env var.
process.env.STAGE_CONFIG = JSON.stringify({ domain: config('DOMAIN'), apiKey: secret('API_KEY') }, managedValueReplacer);

// Consumer (phase 2, possibly a different process): parse with the reviver.
const cfg = JSON.parse(process.env.STAGE_CONFIG, managedValueReviver);
isSecret(cfg.apiKey); // true — brand restored
```

`encodeManagedValue` / `decodeManagedValue` are the single-value primitives; the
`managedValueReplacer` / `managedValueReviver` are drop-in `JSON.stringify` /
`JSON.parse` hooks that apply them across a whole (possibly nested) object.

Contract of the wire form (it is a **published, cross-build compatibility boundary**):

- **Versioned.** Every encoded value carries a protocol version
  (`MANAGED_VALUE_JSON_VERSION`). A decoder rejects a version it does not understand
  instead of guessing, so producer and consumer on different package versions fail
  predictably rather than silently misreading each other.
- **Malformed input.** `decodeManagedValue(v: unknown)` validates exhaustively and
  throws a typed `ManagedValueCodecError` on an unsupported version, unknown kind,
  invalid key, or any other malformed shape. The `managedValueReviver`, by contrast,
  **never throws**: anything that is not an exact wire value is left untouched, so a
  stray or future-versioned tagged object passes through as ordinary data.
- **No collisions.** Only an object whose *sole* property is the codec tag is revived
  into a marker. An ordinary object that merely also happens to carry the tag (plus
  other fields) is **not** treated as a wire value, so no sibling data is silently
  dropped.
- **Schema.** A marker's `schema` object is not serializable and is **not**
  transported; what is transported is its operational bit, so the runtime
  **JSON-parse behavior is preserved** across the boundary (a schema-bearing value
  still comes back parsed, not raw). Deep re-validation, however, needs the real
  schema **re-declared on the far side** — the runtime getter is parse-only either
  way (see "Typed, parsed values with a schema" above).

### Set the values (out of band, never in git)

Standalone hosting apps get two bundled CLIs:

```bash
# Secrets Manager — a secret value is NEVER taken from argv (it would land in
# shell history). Omit the value for a hidden prompt, or pipe it via --value-stdin:
npx hosting-secret set STRIPE_KEY --prefix /myapp/secrets --region us-east-1   # hidden prompt
cat key.txt | npx hosting-secret set STRIPE_KEY --value-stdin --prefix /myapp/secrets
npx hosting-secret list --prefix /myapp/secrets
npx hosting-secret remove STRIPE_KEY --prefix /myapp/secrets

# SSM Parameter Store — a config value is non-sensitive, so a positional value is fine:
npx hosting-config set FEATURE_FLAGS '{"beta":true}' --prefix /myapp/config
```

`set` is **create-or-update**: the first call creates the entry, and running it
again overwrites the value in place (no error, no prompt) — that is how you
rotate a value. A **secret** value is never read from `argv` / shell history:
`hosting-secret set` takes it from a **hidden prompt** or `--value-stdin`, and
passing it positionally is a hard error. A **config** value is non-sensitive, so
`hosting-config set KEY value` positionally is allowed (`--value-stdin` / the
prompt still work). `list` prints names only, never values.

`remove` on a **secret** is recoverable by default — the value enters Secrets
Manager's recovery window and can be restored (guards against a typo'd prod key).
Pass `--force` to delete immediately with no recovery. (`config` removes are always
immediate — SSM Parameter Store has no recovery window.)

> **Footguns to know.**
> 1. **Region.** `--region` (or `AWS_REGION`) must match the region the app deploys
>    to, or the deploy reports the value as "not set".
> 2. **Account-global prefix.** The default prefixes (`/hosting/secrets`,
>    `/hosting/config`) are account-global — if more than one app deploys to the
>    same account, give each its own `secretStore.prefix` / `configStore.prefix`
>    (and matching CLI `--prefix`), or their same-named values collide.
> 3. **`stage` is not a security boundary.** An optional `stage` on
>    `secretStore` / `configStore` resolves `<prefix>/<stage>/<key>` and falls
>    back to the shared `<prefix>/<key>`. To make that fallback work the IAM grant
>    is *static*, so a stage's compute has standing read on **both** the stage
>    value and the shared one. Every stage sharing a prefix can read the shared
>    value — put production-only secrets in a stage-scoped slot and keep only a
>    safe cross-stage default (e.g. a sandbox credential) in the shared slot. Two
>    constructs sharing a prefix are not isolated from each other.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Framework Adapter (nextjs / nuxt / astro)   │
│  - runs build                                │
│  - emits DeployManifest                      │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│  HostingConstruct (CDK L3)                   │
│  - CloudFront distribution                   │
│  - S3 origin (static assets)                 │
│  - Lambda compute (SSR / API / middleware)   │
│  - Optional: WAF, DNS, monitoring, warmup    │
└──────────────────────────────────────────────┘
```

## SSR compute: Lambda or Lambda Web Functions

By default the SSR server runs on a Lambda function behind an API Gateway REST
API (`compute.type: 'lambda'`). HTTP-server frameworks run inside it via the
Lambda Web Adapter. Set `compute.type: 'web-function'` to run it on
[AWS Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
instead. The framework's own Node.js server then runs directly on Lambda, and
CloudFront reaches it through origin access control (OAC):

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  compute: {
    type: 'web-function',
    timeout: Duration.seconds(60),
    webFunction: { maxEnvironments: 20 }, // optional tuning
  },
});
```

```
CloudFront ─(OAC, SigV4)─▶ Web Function endpoint (IamAuth) ─▶ framework server
```

| | `'lambda'` (default) | `'web-function'` |
|---|---|---|
| Path | CloudFront → API Gateway → Lambda (+ Lambda Web Adapter) | CloudFront → Web Function endpoint |
| Requests per environment | 1 | many (dynamic, up to `webFunction.maxConcurrencyPerEnvironment`, 1–128, default 64) |
| Billing | duration × memory | active CPU + memory over the environment lifetime |
| Origin auth | shared-secret header checked by API Gateway | IAM: OAC-signed, endpoint grants only this distribution |
| Warm capacity | `provisionedConcurrency` / `warmup` | automatic headroom (scales to zero when idle) |
| Regions | all | us-east-1, us-east-2, us-west-2, ap-northeast-1, eu-west-1 |
| Runtime | Node.js 18–24, x86_64 | Node.js 24, Arm64, 2 GB per environment |

**Requirements.**
- An **HTTP-server build**. With `@aws-blocks/blocks`' `Hosting` every built-in
  framework works unchanged, because the adapters switch their output when
  Web Functions are selected:
  - **Astro** (`@astrojs/node` standalone) and **SvelteKit** (`adapter-node`)
    already emit an HTTP server.
  - **Nuxt/Nitro** builds with the `node-server` preset instead of `aws-lambda`.
  - **Next.js** builds with OpenNext's `node` wrapper/converter as a container
    origin. A user `open-next.config.ts` must then set `wrapper: 'node'`,
    `converter: 'node'` and `generateDockerfile: true`.
- If you run an adapter yourself in front of `HostingConstruct`, wrap the run in
  `withComputeTarget('web-function', …)` from `@aws-blocks/hosting/adapters` to
  get the same output.
- An event-handler build (an OpenNext `aws-lambda` wrapper or a Nitro
  `aws-lambda` preset) fails synth with `WebFunctionUnsupportedComputeError`.
- Synth also fails with `WebFunctionUnsupportedRegionError` outside the
  supported Regions. If Web Functions have since launched in your Region,
  bypass the check with `skipRegionValidation: true`.

**What changes.**
- **Lambda-only knobs are ignored with a synth warning:** `memorySize`,
  `reservedConcurrency`, `provisionedConcurrency` and `warmup`. Use
  `webFunction.maxEnvironments` and `webFunction.rateLimit` to cap scale.
- **Only the SSR server moves.** Image optimization, ISR revalidation,
  middleware and edge routes stay on Lambda.
- **Native modules must be Arm64.** Astro's bundled `sharp` is installed for
  Arm64 automatically.
- **The default SSR CloudWatch alarms aren't created** for a Web Function yet.
- **Separate resources.** The SSR server is exposed as
  `HostingConstruct.computeWebFunctions`, not in `computeFunctions`. Grant it
  access to AWS resources through its `grantPrincipal`.

**Under the hood.**
- **Code bucket.** Web Functions only read code from a versioned S3 object.
  Each deploy copies the bundle zip onto one fixed key
  (`web-function/<fn>/code.zip`) in a versioned code bucket, and pins the new
  revision to the object version that copy returned. Superseded zips become
  non-current versions, which a lifecycle rule expires after 30 days.
- **Revisions.** Every revision property is create-only, so the revision's
  logical ID is derived from its content, as with `lambda.Version`. A changed
  bundle or environment variable adds a new revision and re-points the endpoint
  (weight 100), then CloudFormation deletes the old revision during cleanup.
  The deploy never needs a replacement update, which matters because sandbox
  deploys run in Express Mode with rollback disabled, and CloudFormation
  rejects replacements there.
- **Header hygiene.** Responses from a Web Function carry `lambda-web-logstream`,
  which names the internal log stream and revision. Hosting removes it with a
  response headers policy, which applies to every status code including
  4xx/5xx. The policy has the same settings as AWS's managed
  `SecurityHeadersPolicy`, plus `removeHeaders`.
  - It counts against the account's response headers policy quota (20 by
    default). That's one policy per Web Function stack.
  - To share one policy across stacks instead, create it once with
    `removeHeaders` and pass it as `cdn.responseHeadersPolicy` in each stack:

    ```ts
    // once, e.g. in a shared-infra stack
    new ResponseHeadersPolicy(shared, 'WebFunctionHeaders', {
      securityHeadersBehavior: { /* … */ },
      removeHeaders: ['lambda-web-logstream'],
    });
    // in each hosting stack
    cdn: { responseHeadersPolicy: ResponseHeadersPolicy.fromResponseHeadersPolicyId(this, 'Headers', policyId) }
    ```

    A BYO policy gets a synth reminder to include the removal, because
    Hosting can't inspect or extend it.
- **Native modules.** Synth warns when the bundle contains x86-64 `.node`
  binaries. Web Functions run on Arm64, and Lambda doesn't check that the
  server starts when it activates a revision, so a server that crashes on
  start would otherwise deploy green.
- **Entry shim.** An entry shim, `__aws_blocks_web_entry.mjs`, is written into
  the bundle. It maps the listen address in `AWS_LAMBDA_HTTP_ENDPOINT` onto
  the framework's `HOST`/`PORT` variables, then imports the server entry.
- **Resource policy.** CloudFormation has no resource type for a Web Function's
  resource-based policy. A small custom resource grants the distribution
  `lambda:InvokeWebFunctionEndpoint`.

## Front doors

The front door is the public entry point in front of the app: it exposes one
address and routes each request to the static assets, the server-rendering
compute, image optimization, or the backend API. Pick it with the `frontDoor`
prop (on `HostingConstruct`, or on `Hosting` from `@aws-blocks/core`):

| `frontDoor` | What serves the app |
|---|---|
| omitted / `'cloudfront'` | The global CloudFront CDN (default): edge cache, WAF, custom domain, streaming, skew protection. |
| `{ kind: 'alb' }` | A regional Application Load Balancer (no CDN): asset-proxy Lambda, SSR/image Lambda targets, same-origin API forwarder; regional WAF, access logs and alarms. SSR responses are buffered. |
| `{ kind: 'apiGateway', api?: 'http' \| 'rest' }` | Amazon API Gateway (no CDN, no VPC, scale-to-zero). `'http'` (default) buffers SSR responses. `'rest'` streams them, but needs a custom `domain`: its own URL carries the `/prod` stage, which the app's root-relative links miss, so synth fails without one (`RestFrontDoorNeedsDomainError`). |
| `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` | A thin CloudFront edge in front of a full ALB router (`Hosting` from `@aws-blocks/core` only). |
| `'none'` | No front door: a public S3 website bucket (HTTP only, static sites only; the client calls the API cross-origin). |
| `{ kind: 'custom', door }` | Your own door (see below). |

There is no feature check: a door applies the features the app asks for
(custom domain, WAF, logging, alarms, geo) as far as it supports them. An ALB,
for example, has no edge, so it has no edge cache or geo restriction. `'none'`
fails synth for an app with a server, because a website bucket only serves
static files.

Every door except `'none'` serves the API on the app's own origin: `/aws-blocks/*`
(RPC and sign-in) and each of the backend's raw routes. The ALB and API Gateway
doors serve static files through an asset-proxy Lambda that answers like the
CloudFront door: a missing file 404s (the SPA fallback is for extensionless
paths only), and each file keeps the `Cache-Control` it was uploaded with.

A door that invokes the server without streaming (the ALB, the stacked door's
ALB router, the API Gateway HTTP API) gets a server built in buffered mode. Next.js
is the exception: its OpenNext build targets a streaming API Gateway REST
integration, so serve Next.js through CloudFront, the `'rest'` door, or a door
that streams.

### Bring your own front door

A door is one function. `defineFrontDoor` types it:

```ts
// aws-blocks/my-door.ts
import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
import { cf, defineFrontDoor } from '@aws-blocks/hosting/constructs';

export const myDoor = defineFrontDoor({
  // A name for this door, used in error messages.
  service: 'my-cdn',

  // Called ONCE at synth, after AWS Blocks has created the bucket, the compute
  // and the API, and before it declares the asset uploads.
  build(scope, { app, origins, features }) {
    const dist = new Distribution(scope, 'Cdn', {
      defaultBehavior: { origin: cf.origin(origins.server ?? origins.assets) },
      additionalBehaviors: {
        ...cf.behaviors(app.routes), // each route → its origin
        ...cf.apiBehaviors(origins.api), // /aws-blocks/* and raw routes → the API
      },
      webAclId: features.waf?.webAclArn,
    });
    return {
      url: `https://${dist.distributionDomainName}`, // the app's address (required)
      onUpload: ({ uploads }) => cf.invalidate(dist, { after: uploads }), // purge after the uploads
    };
  },
});
```

```ts
// aws-blocks/index.cdk.ts
new Hosting(stack, 'Hosting', { root: '..', api: stack, frontDoor: { kind: 'custom', door: myDoor } });
```

**Streaming or buffered.** A door that invokes the server without streaming
(an ALB Lambda target, an API Gateway HTTP API integration, a `BUFFERED`
Function URL) declares `serverResponse: 'buffered'`, and AWS Blocks builds the
server to answer with a complete response. The default is `'streaming'`.

```ts
export const myAlbDoor = defineFrontDoor({
  service: 'my-alb',
  serverResponse: 'buffered', // the ALB invokes the server without streaming
  build: buildMyAlb, // your build: an ALB whose default target is origins.server.fn
});
```

**What the door receives (`DoorInput`).**

- `app`: the app facts. `buildId`, `basePath`, `assetPrefix`, `spaFallback`,
  `routes` (most-specific first, each already joined to its origin object),
  `redirects`, `headers`, `errorPages`, `wwwRedirect`, and `skew` (present only
  when skew protection is on).
- `origins`: what AWS Blocks provisioned.
  - `assets`: `{ bucket, prefix, sourceDir }`. The private bucket and the
    `builds/<buildId>/` prefix.
  - `server`: `{ fn, url, streaming }`. `streaming` says whether the server
    streams its response (see `serverResponse`). The Function URL is created on
    first read, in the matching invoke mode.
  - `image`: `{ fn, url, pathPrefix }`.
  - `api`: `{ url, host, stagePath, paths, authPaths }`. `paths` is
    `/aws-blocks/*` plus every raw route; `authPaths` is `/aws-blocks/auth/*`.
- `features`: the features the app asked for, each present only when asked for:
  `customDomain`, `waf`, `logging`, `alarms`, `geo`.
- `upstream`: present only for a door stacked in front of another door.

**What the door returns.**

- `url` (required): the app's public address. It becomes the `HostingUrl`
  output and `Hosting.url`, the backend's trusted origin
  (`BLOCKS_PUBLIC_ORIGIN`), and an allowed CORS origin. When the door serves a
  custom domain, return that domain. A missing or empty `url` fails synth with
  `MissingFrontDoorUrlError`.
- `originHandle`: how a door in front of this one reaches it. It is derived from
  `url` unless given.
- `publicBucket`: a public bucket the door serves from. The runtime
  `config.json` is published there.
- `onUpload({ uploads, buildId })`: called after the asset uploads are declared,
  to declare resources that must run after them.

**The wiring check.** AWS Blocks checks one thing about a bring-your-own door:
its routing, from what the `cf.*` helpers recorded.

- If nothing reaches the static assets, synth fails with `ServeStaticAsset`.
- If the app has an API and none of `origins.api.paths` were wired, synth fails
  with `ProxySameOriginApi`.
- If some API paths (for example a raw route) were left unwired, synth warns.

It does not check features. If a door ignores `features.waf`, the app deploys
without a WAF.

**Known limit.** The check sees only what the helpers recorded, so a door that
wires correctly with raw CDK gets a false alarm. Declare hand-wired origins with
`cf.recordWired(origins.assets)` and `cf.recordWired(origins.api)` (optionally
with the paths you wired), or turn the check off with
`frontDoor: { kind: 'custom', door, wiringCheck: false }`.

**Testing a door.** Use `assertDoorConformance(door)` from
`@aws-blocks/hosting/constructs` in the door's own tests. It builds the door
against a sample SPA with an API and runs the same checks: the shape, a
non-empty `url`, and the wiring.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way, and the pieces
they share are exported for your own doors: `generateAlbAssetProxyCode`,
`generateApiGwAssetProxyCode`, `backendBaseUrl`, `coalesceRoutes`,
`routeSpecificity`, `createSecurityHeadersPolicy`.

## Build retention & rollback

Each deploy uploads its assets under an immutable `builds/<buildId>/` prefix and
flips a CloudFront KeyValueStore pointer (`meta.b`) to the new build. Old builds
are retained for `storage.buildRetentionDays` (default **30**) so you can roll
back, then expired by an S3 lifecycle rule.

- **The build currently being served is never expired**, no matter how long ago
  it was deployed. Only *superseded* builds (ones a later deploy replaced) are
  eligible for cleanup — they are tagged `aws-blocks:build-state=superseded` at
  the cutover, and the lifecycle rule matches only that tag.
- Raise `storage.buildRetentionDays` for a longer rollback window. It must be at
  least `skewProtection.maxAge` (converted to days), or synth throws
  `InvalidSkewProtectionMaxAgeError` — a skew cookie must not outlive the build
  it pins to.
- Optional `storage.deployIntervalDays` is an advisory hint: if you set it and
  it is ≥ `buildRetentionDays`, synth prints a warning that superseded builds
  may expire before your next deploy (shrinking the rollback window). It never
  blocks a deploy and never affects the live build.

> **Cleanup caveat:** a build is tagged superseded only during a normal deploy
> cutover (an `Update` that flips `meta.b`). Builds that become stale outside
> that path — every build already present before upgrading to this version, or
> builds left by an aborted/rolled-back deploy — are never tagged, so the
> lifecycle rule never expires them and they accumulate until you remove them
> manually. This is safe (nothing deletes the live build), just not
> self-cleaning for pre-existing artifacts.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  storage: {
    buildRetentionDays: 90,   // keep 90 days of rollback targets
    deployIntervalDays: 30,   // advisory only
  },
});
```

## Access logging

CloudFront access logs are delivered to a dedicated, private S3 bucket. Two
pipelines are supported via `logging.version`:

| | `'v1'` (default) | `'v2'` |
| --- | --- | --- |
| Mechanism | Legacy standard logging (inline on the distribution) | Standard logging v2 (CloudWatch Logs vended-logs delivery) |
| Log bucket ACLs | Required (`BUCKET_OWNER_PREFERRED`) | **None** (`BUCKET_OWNER_ENFORCED`) |
| S3 key layout | Flat prefix | **Partitioned** — `date` or Hive-compatible (`logging.partitioning`) |
| Record format | W3C tab-separated | `w3c` \| `plain` \| `json` \| `parquet` (`logging.format`) |
| CloudFront charge | None (S3 storage only) | Per-GB vended-logs delivery charge |
| Region constraint | Any | Delivery source must be **us-east-1** |

`v1` stays the default (no billing change). Opt into `v2` for an ACL-free log
bucket and a partitioned, query-ready layout with no post-processing Lambda:

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  logging: {
    enabled: true,
    version: 'v2',
    partitioning: 'hive',   // or 'date' (default). Athena/Glue-friendly.
    format: 'parquet',      // or 'w3c' (default), 'json', 'plain'
    retentionDays: 90,
  },
});
```

> **Region:** because CloudFront is a global service, standard logging v2's
> delivery source must be created in **us-east-1** (same constraint as ACM
> certificates). Synth throws `LoggingV2RegionError` in any other Region — deploy
> the hosting stack to us-east-1 or use `version: 'v1'`. When the stack's Region
> is unresolved at synth (an environment-agnostic stack), synth emits a
> `LoggingV2RegionUnresolved` warning instead. `skipRegionValidation` skips this
> check along with the WAF, ACM and Lambda Web Adapter Region checks.

> **Entry point:** `version`, `partitioning` and `format` are available on
> `HostingConstruct` from `@aws-blocks/hosting`. The `Hosting` block in
> `@aws-blocks/core` currently accepts only `logging.enabled` and
> `logging.retentionDays`, so it always uses v1.

## SSR caching & cache-key credentials

`cdn.ssrDefaultTtl` enables CloudFront edge caching of SSR responses that carry
no explicit `Cache-Control` header. Those responses are then shared at the edge,
and the SSR cache key does **not** include `Authorization` or session cookies by
default — so one cached entry would answer requests regardless of their
credentials. Set `cdn.cacheKeyCookies` (your session cookie name(s)) and/or
`cdn.cacheKeyHeaders` (e.g. `'authorization'`) so cached responses are keyed per
credential. Synth **fails closed**: if `ssrDefaultTtl` resolves to `> 0` and
neither is set, synthesis throws.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  cdn: {
    ssrDefaultTtl: Duration.seconds(60),
    cacheKeyCookies: ['session'], // your session cookie name(s)
  },
});
```

The guard covers only `ssrDefaultTtl`. Routes made cacheable by the origin
emitting `s-maxage`/`revalidate` (Next.js `revalidate`, Nuxt `routeRules`,
Astro SSR) are not seen by synth, so those routes must set the cache-key options
themselves or emit `Cache-Control: private`. Any route that sets cookies or
otherwise varies per user should emit `Cache-Control: private`.

CloudFront caps the cache key at 10 cookies and 10 headers; reserved slots leave
**8 cookies** and **5 headers** for callers. `accept-encoding` is handled
automatically and is not allowed in `cacheKeyHeaders`.

On a compute deploy every request is routed through a single default cache
behavior, so `cacheKeyCookies`/`cacheKeyHeaders` affect the cache key for **all**
routes on that behavior. To keep shared assets from being keyed per credential,
the edge router deletes the configured cache-key cookies and headers on static
and image routes before origin selection — those routes compute a shared cache
key, while SSR/compute routes keep the credentials and stay keyed per credential.
Because the router deletes them at viewer-request, those cookies and headers are
also not forwarded to the origin on static and image routes (e.g. an auth-gated
image source would not receive them).

## Custom domains

Configure a custom domain through the `domain` prop on `HostingConstruct`
(`HostingDomainConfig`). CloudFront only accepts ACM certificates in
**us-east-1**, so every certificate, whether auto-provisioned or
bring-your-own, must live in us-east-1. There are two paths, depending on where
you manage DNS.

### Route 53 (automatic)

Provide `hostedZone` (the zone domain name) or `hostedZoneId`. The construct
provisions a DNS-validated ACM certificate and creates the A and AAAA alias
records for you. Validation is automatic when the hosted zone is in the same
account as the deployment, because the construct writes the ACM validation
records into the zone itself.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  domain: {
    domainName: 'app.example.com',
    hostedZone: 'example.com', // a Route 53 zone you control
  },
});
```

Use `hostedZoneId` to skip `HostedZone.fromLookup()`, which otherwise requires
`env: { account, region }` on the stack. This is useful in pipeline stages:

```ts
domain: {
  domainName: 'app.example.com',
  hostedZone: 'example.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
}
```

### Bring your own DNS (manual)

If you manage DNS elsewhere (your registrar, Cloudflare, or another provider),
omit `hostedZone` and `hostedZoneId` and pass a pre-validated `certificate`, an
ACM certificate in us-east-1. The construct creates no DNS records. Instead it
emits the CloudFront distribution domain as a `DistributionDomainName`
CloudFormation output, so you can point a CNAME at it from your own DNS
provider.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  domain: {
    domainName: 'app.example.com',
    // no hostedZone: you manage DNS externally
    certificate: myPreValidatedCert, // ACM cert in us-east-1, pre-validated
  },
});
```

### Error behavior

Omitting both `hostedZone` / `hostedZoneId` and `certificate` throws
`MissingCertificateError` at synth time. Synthesis fails immediately, so the
deploy never starts and there is no 72-hour CloudFormation wait on an
unvalidated certificate. A bring-your-own certificate outside us-east-1 fails
synthesis with `InvalidCertificateRegionError`.

### Two-phase workflow for external DNS

A certificate must be validated before CloudFront will serve the domain, and
the CloudFront domain is only known after deploy. Set up external DNS in two
phases around the deploy:

1. **Before deploy:** request an ACM certificate in **us-east-1** for your
   domain and validate it (add the ACM validation CNAME to your DNS, or use
   email validation). Wait until the certificate status is **Issued**.
2. **Deploy:** deploy the stack with `domain: { domainName, certificate }`. The
   stack emits the `DistributionDomainName` output (for example
   `d1234abcd.cloudfront.net`).
3. **After deploy:** in your DNS provider, create a CNAME from your domain
   (`app.example.com`) to the `DistributionDomainName` value. For an apex
   domain, use an ALIAS or ANAME record if your provider supports it.

## Off-region CloudFront alarm parity

AWS CloudFront metrics only publish in `us-east-1`. A CloudWatch alarm
can only evaluate a metric in its own region, so the CloudFront 5xx
alarm cannot be placed in a non-`us-east-1` hosting stack.

When `HostingConstruct` detects that the stack's region is **not**
`us-east-1` it automatically synthesizes a companion stack named
`<stackName>-CfMonitoring-<addr>` (the `<addr>` suffix keeps the id
unique when several hosting constructs share a stage) pinned to
`us-east-1`. That stack:

- creates its own encrypted SNS topic (the alarm action target),
- wires the CloudFront 5xx rate alarm to that topic,
- applies the same `monitoring.subscriptions` you pass to the hosting
  construct, so you subscribe in one place and both regions are covered,
  and
- emits a `MonitoringTopicArnUsEast1` CloudFormation output so operators
  who want the raw ARN can find it.

> **Requirement:** because the companion stack is region-pinned you must
> set `env: { account, region }` on the parent hosting stack when
> deploying outside `us-east-1`, exactly as you would for a WAF stack
> (see `waf_construct.ts`). If the region is resolved but the account is
> unresolved, only the CloudFront alarm is skipped (with a loud synth
> warning); all other alarms are kept. A fully env-agnostic stack
> (unresolved-token region) creates the alarm locally and warns that it
> will never fire if the app deploys outside `us-east-1`. See D-016.

Off-region placement is **always on**; there is no opt-out. The
CloudFront 5xx alarm is the whole point of `monitoring`, and a
silently-missing alarm is exactly the bug this fixes (#481).

Subscribe with endpoint subscriptions (`EmailSubscription` /
`UrlSubscription` from `aws-cdk-lib/aws-sns-subscriptions`):

```ts
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

new HostingConstruct(this, 'Hosting', {
  // ...
  monitoring: {
    subscriptions: [new subs.EmailSubscription('oncall@example.com')],
  },
});
```

Resource-target subscriptions (Lambda/SQS) are not yet supported —
applying them to the us-east-1 topic would create an unresolvable
cross-region reference. For a custom action, reach the alarms directly
via `hosting.monitoring.alarms`. In `us-east-1` no companion stack is
created — the alarm stays local.


## Development

```bash
npm run build        # compile TypeScript
npm test             # run tests (node --test)
```

## License

Apache-2.0
