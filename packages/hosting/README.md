# @aws-blocks/hosting

Low-level CDK L3 constructs for deploying web applications on AWS
(S3, Lambda, WAF, monitoring, DNS), behind a front door of your choice:
CloudFront by default, an Application Load Balancer, Amazon API Gateway, an S3
website, or your own (see [Front doors](#front-doors)).

## Overview

This package provides:

1. **`HostingConstruct`** -- a CDK L3 construct that provisions a full hosting
   stack (a front door — a CloudFront distribution by default —, S3 origin,
   Lambda compute, optional WAF, monitoring alarms, and DNS records).

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
│  - front door (CloudFront by default)        │
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
    `removeHeaders` and pass it as `frontDoor.features.responseHeadersPolicy`
    in each stack (`cdn.responseHeadersPolicy` is its deprecated alias):

    ```ts
    // once, e.g. in a shared-infra stack
    new ResponseHeadersPolicy(shared, 'WebFunctionHeaders', {
      securityHeadersBehavior: { /* … */ },
      removeHeaders: ['lambda-web-logstream'],
    });
    // in each hosting stack
    frontDoor: {
      features: { responseHeadersPolicy: ResponseHeadersPolicy.fromResponseHeadersPolicyId(this, 'Headers', policyId) },
    }
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
| omitted / `'cloudfront'` / `{ features }` | The global CloudFront CDN (default): edge cache, WAF, custom domain, streaming, skew protection. |
| `{ kind: 'alb' }` | A regional Application Load Balancer (no CDN): asset-proxy Lambda, SSR/image Lambda targets, same-origin API forwarder; regional WAF, access logs and alarms; HTTPS at your domain with `certificate` + `features.domain`. SSR responses are buffered. |
| `{ kind: 'apiGateway', api?: 'http' \| 'rest' }` | Amazon API Gateway (no CDN, no VPC, scale-to-zero). `'http'` (default) buffers SSR responses. `'rest'` streams them, but needs a custom `domain`: its own URL carries the `/prod` stage, which the app's root-relative links miss, so synth fails without one (`RestFrontDoorNeedsDomainError`). |
| `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` | A CloudFront edge in front of a full ALB router (`Hosting` from `@aws-blocks/core` only): static routes come straight from S3 at the edge, the API and dynamic routes go through the ALB, which admits only the edge. |
| `'none'` | No front door: a public S3 website bucket (HTTP only, static sites only; the client calls the API cross-origin). |
| `{ kind: 'custom', door }` | Your own door (see below). |

`frontDoor` is checked at synth: an unknown door (`'alb'` as a string,
`{ kind: 'ALB' }`), an option the kind doesn't take, or a value of the wrong
shape (`api: 'REST'`, an ARN string as `certificate`) fails with
`UnsupportedFrontDoorError` or `InvalidFrontDoorOptionError`, and an unknown key
inside a `features` setting (`waf: { enable: true }`) with
`InvalidFrontDoorSettingError`.

Some apps need the CloudFront door:

- `'none'` fails synth for an app with a server, because a website bucket only
  serves static files.
- `compute: { type: 'web-function' }` (AWS Lambda Web Functions) works with the
  CloudFront door only: every other door routes to Lambda functions, so a Web
  Function behind it would get no traffic. Synth fails with
  `UnsupportedComputeFrontDoorError` for any other door.
- Next.js middleware (`middleware.ts`, built as a Lambda@Edge function) runs
  only on the CloudFront door. Behind any other door synth fails with
  `MiddlewareNeedsCloudFrontDoorError` rather than deploying the app with its
  middleware (and any route gating it does) skipped.
- A streaming server (Next.js through OpenNext, or Nitro with
  `awsLambda.streaming: true`) answers only through a door that streams: the
  CloudFront door or `{ kind: 'apiGateway', api: 'rest' }`. The ALB door, the
  stacked door (its router is an ALB) and the HTTP API invoke the server
  without streaming, so synth fails with
  `StreamingServerNeedsStreamingDoorError` instead of deploying an app whose
  pages never answer.

### Settings per door kind

Each door kind takes its settings as `features`, typed for that kind: a
setting the chosen door doesn't implement does not compile. `{ features }`
with no `kind` is the CloudFront default with settings.

```ts
frontDoor: { features: { waf: { enabled: true }, priceClass: PriceClass.PRICE_CLASS_ALL } }
frontDoor: { kind: 'alb', certificate, features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com' }, waf: { enabled: true } } }
frontDoor: { kind: 'apiGateway', api: 'rest', features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com' } } }
frontDoor: { kind: 'alb', features: { geoRestriction: { type: 'allowlist', countries: ['US'] } } } // ✗ type error
```

| Setting | CloudFront | ALB | API Gateway | Custom (BYO) |
|---|---|---|---|---|
| `domain` | ✓ (certificate in us-east-1, aliases, Route 53 records, `wwwRedirect`) | ✓ (regional certificate, HTTPS listener, :80 → :443 redirect, Route 53 alias records; no `wwwRedirect`) | ✓ (regional; no `wwwRedirect`) | ✓ |
| `waf` | ✓ (CLOUDFRONT-scoped web ACL) | ✓ (REGIONAL web ACL) | – | ✓ |
| `logging` | ✓ | ✓ (the ALB's own logs: off unless set) | – | ✓ |
| `monitoring` | ✓ | ✓ (`enabled` only: ALB 5xx and latency alarms, off unless set, no topic or subscriptions) | – | ✓ |
| `skewProtection` | ✓ | – | – | ✓ |
| `geoRestriction` | ✓ | – | – | ✓ |
| `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas` | ✓ | – | – | – |

`geoRestriction.type` is `'allowlist'` or `'denylist'` (the legacy `'whitelist'`
/ `'blacklist'` still work and mean the same; any other value fails synth). The
asset bucket's own access logs are on by default on every door;
`logging: { enabled: false }` turns them off.

The door's own options (`vpc`, `internal`, `certificate`, `api`, `door`,
`wiringCheck`) stay next to `features`. On the ALB, a `certificate` needs
`features.domain` (synth fails with `AlbCertificateNeedsDomainError`
otherwise): a certificate can't cover the ALB's own `*.elb.amazonaws.com` name,
so the app is browsed at your domain, which must then be its URL (the trusted
origin and the CORS origin). The stacked door (`Hosting` from
`@aws-blocks/core`) takes its settings per layer:
`features: { edge: { waf: { webAclArn }, contentSecurityPolicy }, router: { domain, waf, logging, monitoring } }`
— the edge takes your CLOUDFRONT-scoped web ACL, the ALB router a REGIONAL one.
`'none'` takes no settings.

**Migrating from the top-level props.** `domain`, `waf`, `logging`,
`monitoring`, `skewProtection` and the `cdn.*` settings (`cdn.priceClass` →
`features.priceClass`, …; `cdn.webAclArn` → `features.waf.webAclArn`) are
deprecated aliases. They keep working: at construction they are merged into
the effective `frontDoor.features`, and an existing app that sets them with no
`frontDoor` (or `'cloudfront'`) synthesizes the same template. Move each one
into `frontDoor.features` under the same name. Setting a setting both ways
fails synth with `FrontDoorSettingConflictError`, naming both; a top-level prop
the chosen kind doesn't implement (for example `cdn.geoRestriction` with
`{ kind: 'alb' }`) fails synth with `UnsupportedFrontDoorSettingError`, naming
the kind and the prop.

Every door except `'none'` serves the API on the app's own origin: `/aws-blocks/*`
(RPC and sign-in) and each of the backend's raw routes registered before
`Hosting` (`DoorInput.origins.api.paths`, the same set the CloudFront door turns
into behaviors). A door served over plain HTTP with an API (an ALB without a
certificate) warns at synth (`@aws-blocks/hosting:PlainHttpFrontDoor`): sign-in,
cookies and every RPC then travel unencrypted. It also doesn't take over the
API's address: the `ApiUrl` native clients use stays the backend's own HTTPS
endpoint.

A door that invokes the server without streaming (the ALB, the stacked door's
ALB router, the API Gateway HTTP API) gets a server built in buffered mode. Next.js
is the exception: its OpenNext build targets a streaming API Gateway REST
integration, so serve Next.js through CloudFront, the `'rest'` door, or a door
that streams.

Behind the ALB, the server's target group sends and expects multi-value
headers, so several `Set-Cookie` headers survive. A Lambda Web Adapter server
(Astro, SvelteKit, Nitro `node-server`) reads the ALB event as is; a native
handler server (Nitro's default `aws-lambda` preset) runs behind a small ALB
event shim (`blocks_alb_event.mjs`, written next to the handler at synth) that
maps the ALB event to the API Gateway REST shape and the response back.

### The ALB and API Gateway doors: rules and limits

**Static files.** The asset proxy answers like the CloudFront door: a missing
file 404s (the SPA fallback is for extensionless paths only), and each file
keeps the `Cache-Control` it was uploaded with. It also:

- percent-decodes the path (`/My%20Resume.pdf`), and answers 400 for a dot
  segment, an encoded slash or backslash, or a malformed escape;
- gzips text, JSON, JavaScript, SVG and similar files of 1 KiB or more for a
  client that accepts it (`Vary: accept-encoding`);
- returns `ETag` and `Last-Modified`, and answers a matching `If-None-Match` /
  `If-Modified-Since` with a body-less 304;
- adds `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`
  and `Referrer-Policy` to every response (an app header rule of the same name
  wins). Server and API responses don't pass the proxy and don't get them.

**The build cutover.** The asset proxy's environment names the build
(`builds/<buildId>`), and it changes only after every upload of the build —
the resolved runtime config included — has landed, so the previous build keeps
serving until then. There is no skew protection on these doors: a tab opened
before a deploy that later loads a code-split chunk of the previous build gets
a 404. Old builds are kept (rollback works); they are not tagged for the
lifecycle rule as on the CloudFront door, so they are kept until you remove
them.

**Redirects, headers and error pages.** The app's redirects, per-pattern
response headers and error pages are applied by the door's asset proxy (and,
on the ALB, the headers also by the API forwarder) with the CloudFront door's
semantics, using the same matching code:

- redirects: first match wins, a wildcard destination gets the matched tail
  (`/old/*` → `/new/*`), and the status is kept exactly (301, 302, 307, 308).
  A spliced target that starts with extra slashes or backslashes keeps one
  (`/old//evil.example` never becomes `Location: //evil.example`). Every
  redirect source is routed to the asset proxy (an ALB listener rule, an HTTP
  API route, a REST resource);
- header rules: every matching rule is added to a successful response (not to
  a redirect or an error, as at the CloudFront edge);
- error pages: a missing static file answers with the 404 page (status 404),
  an S3 failure with the 500 page (status 500). The 404 page is the app's
  `errorPages.notFound`, else the framework build's, else, for a multi-page
  static site that ships none (Astro `output: 'static'` without a 404 page),
  AWS Blocks' default "404 — Page Not Found" page, as on the CloudFront door.
  An SPA keeps its `index.html` fallback.

Responses the door sends straight to a function or the backend don't pass
through those proxies: server-rendered (SSR) and image-optimization responses,
and on API Gateway the API (proxied natively). Synth names exactly what is not
applied (`@aws-blocks/hosting:DoorRulesNotApplied`). The CloudFront door and
the stacked door's edge apply the rules to every response.

**Size and time limits.** The asset proxy returns each file base64-encoded (a
third larger; gzipped first when compressible) in its Lambda response, so a
file is capped by that response's limit:

| Door | Limit on the base64-encoded response | Largest file, about |
|---|---|---|
| ALB (Lambda target) | 1 MB | 750 KB (a compressible file: 750 KB gzipped) |
| API Gateway (Lambda proxy integration) | 6 MB (Lambda's response limit, below API Gateway's 10 MB payload limit) | 4.5 MB |

Synth lists every build asset over the limit
(`@aws-blocks/hosting:AssetExceedsProxyLimit`). Serve large files from the
CloudFront door or the stacked door (static files come straight from S3), or
from a file bucket. The same limits bind everything else these doors carry:

- ALB: a Lambda target's request body and response are each capped at 1 MB,
  for server-rendered pages and API calls alike. The API forwarder returns text
  as UTF-8 (no base64 inflation) and times out after 30 seconds.
- API Gateway: a 10 MB request payload, a 6 MB Lambda response, and a 29-second
  integration timeout.

**ALB listener rules.** Consecutive paths bound for the same target share a
rule (up to five path values each, four beside the stacked router's header
check), and routes that go where the default goes get no rule. A load balancer
allows 100 rules by default; synth warns above that
(`@aws-blocks/hosting:AlbRuleLimit`).

**ALB custom domain.** `{ kind: 'alb', certificate, features: { domain } }`
serves HTTPS (TLS 1.2+, the `RECOMMENDED_TLS` policy) with a port 80 → 443
redirect, Route 53 alias records to the ALB when you give a hosted zone, and
the domain as the app's URL. Without `certificate`, `domain.certificate` is
used, else a DNS-validated regional certificate (needs `hostedZone` /
`hostedZoneId`). Without a hosted zone, point your DNS at the ALB (the
`AlbDnsName` output).

**Internal ALB.** `internal: true` with the default VPC places the ALB in
isolated private subnets (the VPC still has no NAT gateway). With your own VPC,
it goes in that VPC's private subnets. The API forwarder isn't VPC-attached: it
still reaches the backend at its public endpoint.

**API Gateway routes.** Each function gets one API-scoped invoke permission
(not one per route, which would fill Lambda's 20 KB resource policy). A raw
route `/hooks/*` also serves `/hooks` (a greedy `{proxy+}` needs at least one
character). A backend route with a wildcard inside a segment (`/files*`) has
no API Gateway form and fails synth (`UnsupportedRoutePatternError`); a
route-table pattern of that shape is served by the default integration, with a
synth warning (`@aws-blocks/hosting:RouteNotExpressible`). A REST API allows
300 resources by default (every path segment is one); synth warns above that.

### The `'none'` door

`'none'` publishes the build to its own public S3 website bucket, at the root.
Each deploy prunes what the build no longer ships (a removed `*.map` stops being
downloadable), and uploads with the same cache tiers as the other doors (hashed
assets immutable, HTML and the rest revalidated). Pruning includes the previous
build's hashed assets: a tab opened before a deploy that then lazy-loads one of
its chunks gets a 404 (the website's error document) and needs a reload. The page is plain HTTP and the
API is cross-site, so an auth Building Block needs `crossDomain: true`; its
session cookie is then set by the API's own HTTPS response.

### The stacked door

`{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` puts a CloudFront edge
(TLS, cache, security headers, your edge web ACL) in front of the ALB router.

- **Static routes come from S3.** The edge serves the app's static routes
  straight from the private assets bucket (origin access control); only the
  API and the dynamic routes (server rendering, image optimization) go to the
  ALB. Its behaviors follow the router's precedence (the API first, then the
  routes most-specific first), and a viewer-request function resolves the path
  as the router would (basePath, directory index, single-page-app fallback),
  answers the app's redirects, and prefixes the build (`/builds/<buildId>`), so
  a new build never hits the previous build's cached files. The cutover waits
  for the build's uploads, the resolved runtime config included. The app's
  header rules and error pages apply at the edge to every response.
- **Caching.** The API is never cached at the edge. Server-rendered routes
  honor the server's `Cache-Control` and key on cookies; image routes honor
  the origin's TTLs without cookies in the key, and so does the router default
  of a site without a server (where static routes beyond the behavior budget
  go). With a server, those static routes share the server's default (cookies
  in the key). An app with a server gets a CloudFront invalidation on each deploy
  (`manifest.invalidationPaths`, else `/*`), after the new build and server are
  live. The router sees the public host in `x-forwarded-host`.
- **Behavior budget.** A distribution allows 25 behaviors, the default
  included. Over that, the router becomes the default, API paths no static
  route can shadow are left to it first, and the rest goes through the ALB
  (`@aws-blocks/hosting:StackedEdgeBehaviorLimit`); files that then reach the
  router are checked against its 1 MB limit.
- **The ALB admits only the edge.** Every listener rule requires a secret
  header (`x-blocks-origin-verify`) that the edge sends; without it the ALB
  answers 403. The value is generated once by Secrets Manager (a secret in the
  stack) and both the edge's origin and the listener rules read it through a
  CloudFormation dynamic reference, so it is in no template and changes only
  when you rotate the secret. To rotate it, put a new value and then deploy a
  change that updates both the distribution and the listener rules:
  CloudFormation re-reads a dynamic reference only for a resource it updates.
  Each rule matches one value, and the listener rules update within seconds
  while the distribution takes minutes to propagate, so expect 403s from the
  router until the edge carries the new value; rotate in a quiet window.
  The ALB forwards the header to its Lambda targets. A native handler server
  (behind the ALB event shim) never sees it; a Lambda Web Adapter server and
  the image-optimization function do, so don't log or report request headers
  verbatim from them (a leaked value lets any CloudFront distribution reach
  the router, past the edge's web ACL).
  An internet-facing ALB's security group admits only the CloudFront
  origin-facing managed prefix list
  (`com.amazonaws.global.cloudfront.origin-facing`, looked up per region at
  deploy). With `internal: true`, the edge reaches the ALB through a CloudFront
  VPC origin, and the ALB's security group admits only that VPC origin's
  service security group (`CloudFront-VPCOrigins-Service-SG`). The standalone
  `{ kind: 'alb' }` door stays public by design.
- **The edge → router hop.** With a router `certificate` and
  `features.router.domain` (the name the certificate covers; Route 53 alias
  records point it at the ALB), the edge connects to the router over HTTPS on
  port 443. A domain with a hosted zone and no certificate gets a DNS-validated
  one. Without either, the hop is plain HTTP on port 80 and unencrypted:
  through a VPC origin (`internal: true`) it stays on the AWS network; to an
  internet-facing ALB it reaches the ALB's public addresses, and synth warns
  (`@aws-blocks/hosting:StackedRouterPlainHttp`). The router's `x-forwarded-proto`
  is `http` on a plain-HTTP hop. A certificate without a router domain fails
  synth (`StackedRouterCertificateNeedsDomainError`).
- There is no custom domain or skew protection on the edge yet.

### Switching doors on a deployed app

Changing `frontDoor` on a deployed stack replaces the front door's resources;
it is not an in-place update.

- **The address changes.** The new door has a new URL (`HostingUrl`,
  `BLOCKS_PUBLIC_ORIGIN`, the CORS origin), so existing sessions (cookies are
  scoped to the old host) and bookmarks to the old address stop working.
- **CloudFront → ALB or stacked** deletes the default distribution and its
  alarms; the ALB door's (and the router's) alarms and access logs are off
  unless you set them. The stacked door has no custom domain yet.
- **A custom domain moving between doors** (for example the CloudFront door's
  `domain` to an API Gateway or ALB door) creates Route 53 records of the same
  name under new logical IDs, which collides with the old ones while both
  exist. Remove the domain from the old door in one deploy, then add it to the
  new door.

### Bring your own front door

A door is one function. `defineFrontDoor` types it:

```ts
// aws-blocks/my-door.ts
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { cf, defineFrontDoor } from '@aws-blocks/hosting/constructs';

export const myDoor = defineFrontDoor({
  // A name for this door, used in error messages.
  service: 'my-cdn',

  // Called ONCE at synth, after AWS Blocks has created the bucket, the compute
  // and the API, and before it declares the asset uploads.
  build(scope, { app, origins, features }) {
    const pages = cf.errorPages(app.errorPages, origins); // the app's 404/500 pages
    const dist = new Distribution(scope, 'Cdn', {
      defaultBehavior: {
        origin: cf.origin(origins.server ?? origins.assets),
        // A server renders per request: every method, no edge cache, the viewer's
        // cookies and query string forwarded (all but Host, which a Function URL rejects).
        ...(origins.server
          ? {
              allowedMethods: AllowedMethods.ALLOW_ALL,
              cachePolicy: CachePolicy.CACHING_DISABLED,
              originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            }
          : {}),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // the app's redirects (viewer request) and per-pattern headers (viewer response)
        functionAssociations: [...cf.redirects(scope, app.redirects), ...cf.headers(scope, app.headers)],
      },
      // A static site: `/` serves the index (the assets origin sits at the build prefix).
      ...(origins.server ? {} : { defaultRootObject: 'index.html' }),
      additionalBehaviors: {
        ...cf.behaviors(app.routes), // each route → its origin
        ...cf.apiBehaviors(origins.api), // /aws-blocks/* and raw routes → the API
        ...pages.behaviors, // the error pages, from the assets
      },
      errorResponses: pages.errorResponses,
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

This door doesn't do two things the built-in CloudFront door does:

- **Single-page-app deep links.** A deep link (`/dashboard/settings`) has no
  file, so S3 answers 403/404. Map those to `/index.html` with `errorResponses`
  (status 200), or resolve the path in a viewer-request function as the
  stacked door's edge does.
- **POST bodies to the server.** `cf.origin(origins.server)` reaches the
  server's Function URL with origin access control, and CloudFront then
  requires the viewer to send an `x-amz-content-sha256` header with any request
  body. Browsers don't, so form posts and server actions answer 403. The
  built-in door reaches the server through an API Gateway REST API with a
  secret header instead. Use a door like that, or the built-in door, for an app
  that posts to its server.

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

- `app`: the app facts. `buildId`, `basePath`, `assetPrefix` (Next.js
  `assetPrefix`; only the Next.js adapter sets it), `spaFallback`, `routes`
  (most-specific first, each already joined to its origin object), `redirects`,
  `headers` and `errorPages` (the app's, else the framework build's, else, for
  a multi-page static site with no 404 page, AWS Blocks' default
  `_not_found.html`).
- `origins`: what AWS Blocks provisioned.
  - `assets`: `{ bucket, prefix, sourceDir }`. The private bucket and the
    `builds/<buildId>/` prefix.
  - `server`: `{ fn, url, streaming }`. `streaming` says whether the server
    streams its response (see `serverResponse`). The Function URL is created on
    first read, in the matching invoke mode.
  - `image`: `{ fn, url }`. Its routes are in `app.routes`.
  - `api`: `{ url, host, stagePath, paths }`. `paths` is `/aws-blocks/*` (RPC
    and sign-in) plus every raw route.
- `features`: the door's `frontDoor.features`, under the same names and shapes,
  each present only when asked for: `domain` (with `wwwRedirect`), `waf` (when
  `enabled` or a web ACL is given), `logging` (when `enabled`), `monitoring`
  (when set and not `enabled: false`; a door gets no `monitoring` unless the
  app sets it), `geoRestriction` (as `'allowlist'` / `'denylist'`), and
  `skewProtection` (on by default, with `maxAge` resolved).

The server origin needs no secret header: `origins.server.url` is a Function
URL with IAM auth (reach it with origin access control, as `cf.origin` does).

**What the door returns.**

- `url` (required): the app's public address. It becomes the `HostingUrl`
  output and `Hosting.url`, the backend's trusted origin
  (`BLOCKS_PUBLIC_ORIGIN`), and an allowed CORS origin, so a trailing slash is
  removed (a browser's `Origin` has none). When the door serves a custom
  domain, return that domain. A missing or empty `url` fails synth with
  `MissingFrontDoorUrlError`.
- `originHandle`: how a door in front of this one reaches it. It is derived from
  `url` unless given.
- `publicBucket`: a public bucket the door serves from. The runtime
  `config.json` is published there.
- `onUpload({ uploads, buildId })`: called after the asset uploads are declared,
  to declare resources that must run after them. What it declares under the
  door's `scope` also runs after the runtime `config.json` upload that
  `Hosting` adds later, so a `cf.invalidate` never caches the placeholder
  config. (A resource created directly under the stack isn't ordered after
  that later upload.)
- `cutover`: the constructs that switch traffic to the new build (whatever
  holds the build id or prefix, e.g. a proxy function whose environment names
  `builds/<buildId>`). Each waits for every upload, the runtime config
  included, so the previous build serves until the new one is whole.

**The wiring check.** AWS Blocks checks one thing about a bring-your-own door:
its routing, from what the `cf.*` helpers recorded.

- If nothing reaches the static assets, synth fails with `ServeStaticAsset`.
- If the app has an API and none of `origins.api.paths` were wired, synth fails
  with `ProxySameOriginApi`.
- If some API paths (for example a raw route) were left unwired, synth warns.
- If the app has redirects, per-pattern headers or error pages and the door
  wired none of them (`cf.redirects`, `cf.headers`, `cf.errorPages`), synth
  warns (`FrontDoorRuleUnwired`).
- If `cf.behaviors` and `cf.apiBehaviors` handed out more than the 24
  behaviors a distribution allows besides its default, synth warns
  (`FrontDoorBehaviorLimit`).

It does not check features. If a door ignores `features.waf`, the app deploys
without a WAF.

**Redirects, headers and error pages.** `cf.redirects(scope, app.redirects)`
and `cf.headers(scope, app.headers)` return CloudFront Function associations
(viewer request and viewer response) that run the same matcher as the built-in
CloudFront door, with the rules inline (a CloudFront Function holds at most
10 KB, so synth fails above that). `cf.errorPages(app.errorPages, origins)`
returns the distribution's `errorResponses` and the behaviors that serve the
pages from the assets. Each returns an empty value when the app has none, so it
can be spread unconditionally. `cf.behaviors` gives an image-optimization
route a cache policy that honors the image function's `Cache-Control` (one per
stack), and `cf.invalidate` grants `cloudfront:CreateInvalidation` on that
distribution only.

**Known limit.** The check sees only what the helpers recorded, so a door that
wires correctly with raw CDK gets a false alarm. Declare hand-wired origins with
`cf.recordWired(origins.assets)` and `cf.recordWired(origins.api)` (optionally
with the paths you wired), hand-wired rules with `cf.recordWired(app.redirects)`
(likewise `app.headers`, `app.errorPages`), or turn the check off with
`frontDoor: { kind: 'custom', door, wiringCheck: false }`.

**Testing a door.** Use `assertDoorConformance(door)` from
`@aws-blocks/hosting/constructs` in the door's own tests. It builds the door
against a sample SPA with an API and runs the same checks: the shape, a
non-empty `url`, and the wiring.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way, and the pieces
they share are exported for your own doors: `generateAlbAssetProxyCode` and
`generateApiGwAssetProxyCode` (pass `app.redirects`, `app.headers` and the
error pages to apply the app's rules; see `AssetProxyOptions`; set
`environment: assetProxyEnvironment(origins.assets)` on the function and
`origins.assets.bucket.grantRead(fn)`),
`generateAlbApiProxyCode` (the ALB's same-origin API forwarder),
`backendBaseUrl`, `coalesceRoutes`, `routeSpecificity`,
`createSecurityHeadersPolicy`, and `ORIGIN_VERIFY_HEADER` /
`CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST`.

**A door that stacks CloudFront over its own ALB.** Lock the ALB to the
distribution the same way the stacked door does: admit only CloudFront in the
ALB's security group, and require a secret header that only the distribution
sends.

```ts
import { OriginProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST, ORIGIN_VERIFY_HEADER } from '@aws-blocks/hosting/constructs';

// In build(scope, input): `alb` is your ApplicationLoadBalancer, `target` its target group.
// A random value (alphanumeric: an ALB header condition treats `*` and `?` as
// wildcards), read by both sides through a dynamic reference.
const secret = new Secret(scope, 'OriginVerify', {
  generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
}).secretValue.unsafeUnwrap();
const listener = alb.addListener('Http', {
  port: 80,
  open: false, // no 0.0.0.0/0 ingress
  defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }),
});
listener.addTargetGroups('FromCloudFront', {
  priority: 1,
  conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [secret])],
  targetGroups: [target],
});
const cloudFront = ec2.PrefixList.fromLookup(scope, 'CloudFront', { prefixListName: CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST });
alb.connections.allowFrom(ec2.Peer.prefixList(cloudFront.prefixListId), ec2.Port.tcp(80));
const origin = new HttpOrigin(alb.loadBalancerDnsName, {
  protocolPolicy: OriginProtocolPolicy.HTTP_ONLY, // the listener above is HTTP :80 (HttpOrigin defaults to HTTPS)
  customHeaders: { [ORIGIN_VERIFY_HEADER]: secret },
});
```

`PrefixList.fromLookup` needs the stack's `env` (account and region); the
built-in door looks the list up at deploy time instead. For an internal ALB,
use `VpcOrigin.withApplicationLoadBalancer(alb)` and admit the VPC origin's
`CloudFront-VPCOrigins-Service-SG` security group (see the CDK
`aws-cloudfront-origins` documentation).

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
pipelines are supported via `frontDoor.features.logging.version` (the top-level
`logging` prop is its deprecated alias):

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
  frontDoor: {
    features: {
      logging: {
        enabled: true,
        version: 'v2',
        partitioning: 'hive',   // or 'date' (default). Athena/Glue-friendly.
        format: 'parquet',      // or 'w3c' (default), 'json', 'plain'
        retentionDays: 90,
      },
    },
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

`frontDoor.features.ssrDefaultTtl` (CloudFront door; formerly
`cdn.ssrDefaultTtl`) enables CloudFront edge caching of SSR responses that carry
no explicit `Cache-Control` header. Those responses are then shared at the edge,
and the SSR cache key does **not** include `Authorization` or session cookies by
default — so one cached entry would answer requests regardless of their
credentials. Set `cacheKeyCookies` (your session cookie name(s)) and/or
`cacheKeyHeaders` (e.g. `'authorization'`) so cached responses are keyed per
credential. Synth **fails closed**: if `ssrDefaultTtl` resolves to `> 0` and
neither is set, synthesis throws.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  frontDoor: {
    features: {
      ssrDefaultTtl: Duration.seconds(60),
      cacheKeyCookies: ['session'], // your session cookie name(s)
    },
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

Configure a custom domain through `frontDoor.features.domain`
(`HostingDomainConfig`; the top-level `domain` prop is its deprecated alias).
This section covers the CloudFront door; the ALB and API Gateway doors take a
**regional** certificate instead (see [Front doors](#front-doors)). CloudFront
only accepts ACM certificates in **us-east-1**, so every certificate, whether
auto-provisioned or bring-your-own, must live in us-east-1. There are two
paths, depending on where you manage DNS.

### Route 53 (automatic)

Provide `hostedZone` (the zone domain name) or `hostedZoneId`. The construct
provisions a DNS-validated ACM certificate and creates the A and AAAA alias
records for you. Validation is automatic when the hosted zone is in the same
account as the deployment, because the construct writes the ACM validation
records into the zone itself.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  frontDoor: {
    features: {
      domain: {
        domainName: 'app.example.com',
        hostedZone: 'example.com', // a Route 53 zone you control
      },
    },
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
  frontDoor: {
    features: {
      domain: {
        domainName: 'app.example.com',
        // no hostedZone: you manage DNS externally
        certificate: myPreValidatedCert, // ACM cert in us-east-1, pre-validated
      },
    },
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
2. **Deploy:** deploy the stack with `frontDoor.features.domain: { domainName, certificate }`. The
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
- applies the same `frontDoor.features.monitoring.subscriptions` you pass to
  the hosting construct (the top-level `monitoring` prop is its deprecated
  alias), so you subscribe in one place and both regions are covered,
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
  frontDoor: {
    features: {
      monitoring: {
        subscriptions: [new subs.EmailSubscription('oncall@example.com')],
      },
    },
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
