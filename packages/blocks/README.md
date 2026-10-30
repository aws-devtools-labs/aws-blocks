# AWS Blocks

**Write your backend and frontend together — fully typed, runnable on your laptop, deployable to AWS unchanged.**

AWS Blocks is a backend framework built from **Building Blocks**: self-contained modules that each bundle a CDK construct, its AWS SDK integration, and a local mock. You compose blocks in one directory, export an API, and call it from your frontend with end-to-end type safety. No client generation, no glue code, no AWS account needed to start.

This package (`@aws-blocks/blocks`) re-exports every Building Block and the core primitives, so you import everything from one place:

```typescript
import { Scope, ApiNamespace, KVStore, AuthBasic } from '@aws-blocks/blocks';
```

- **Type-safe, end to end** — your frontend calls backend methods directly; types flow through automatically.
- **Local-first** — every block runs as an in-memory mock, so you build and test with zero cloud setup.
- **Deploys unchanged** — `npm run sandbox` swaps the mocks for real AWS services (DynamoDB, Aurora, S3, Lambda…). Same code.
- **Low ceremony, high ceiling** — common things are one line; when you need the underlying CDK construct or AWS SDK, it's right there.

## Quick Start

```bash
npx @aws-blocks/create-blocks-app my-app
cd my-app
npm run dev          # → http://localhost:3000  (mocks, no AWS account needed)
```

`--template <name>` picks a starter (`react`, `nextjs`, `backend`, …); see [`@aws-blocks/create-blocks-app`](https://www.npmjs.com/package/@aws-blocks/create-blocks-app).

## How it works

Your entire backend lives in one directory, `aws-blocks/`. You create blocks, then expose methods through an `ApiNamespace`:

```typescript
// aws-blocks/index.ts
import { Scope, ApiNamespace, KVStore } from '@aws-blocks/blocks';

const scope = new Scope('my-app');
const store = new KVStore(scope, 'cache');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getValue(key: string) {
    return await store.get(key);
  },
  async setValue(key: string, value: string) {
    await store.put(key, value);
  },
}));
```

The frontend imports that API and calls it like a local function — fully typed, no fetch, no client codegen:

```typescript
// src/
import { api } from 'aws-blocks';

await api.setValue('greeting', 'hello');
const value = await api.getValue('greeting'); // typed: string | null
```

That's the whole model: **define blocks → export an API → import it on the frontend.** The transport (JSON-RPC under `/aws-blocks/api`) is handled for you and is intentionally invisible.

## Adding auth and data

Blocks compose. Here's the same API gated behind authentication and backed by a queryable table:

```typescript
// aws-blocks/index.ts
import { Scope, ApiNamespace, AuthBasic, DistributedTable } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

const auth = new AuthBasic(scope, 'auth', { passwordPolicy: { minLength: 8 } });

const notes = new DistributedTable(scope, 'notes', {
  schema: z.object({ userId: z.string(), noteId: z.string(), text: z.string() }),
  key: { partitionKey: 'userId', sortKey: 'noteId' },
});

// Sign-up / sign-in endpoints, ready to wire to the frontend
export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async addNote(text: string) {
    const user = await auth.requireAuth(context);          // 401s if not signed in
    const noteId = crypto.randomUUID();
    await notes.put({ userId: user.username, noteId, text });
    return { noteId };
  },
  async listNotes() {
    const user = await auth.requireAuth(context);
    return await Array.fromAsync(notes.query({ where: { userId: { equals: user.username } } }));
  },
}));
```

> **Security:** every `ApiNamespace` method is a public internet endpoint with **no auth by default**. Gate a method by calling `auth.requireAuth(context)` (or `auth.requireRole(...)`) at the top. The local mock enforces nothing either — an ungated method passes every local check and still ships callable by anyone.

On the frontend, `@aws-blocks/blocks/ui` gives you provider-agnostic auth components, or drive `authApi` yourself:

```typescript
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';
import { authApi, api } from 'aws-blocks';

document.body.append(Authenticator(authApi));
onAuthChange(authApi, (user) => {
  if (user) api.listNotes().then(render);
});
```

## Building Blocks

Start from what you need:

- **Store data**
  - Simple key → value (caches, flags, user prefs) → `KVStore` (bb-kv-store)
  - Structured records with indexes and queries → `DistributedTable` (bb-distributed-table) — **default for most data**
  - Relational / SQL (joins, transactions) → see [Choosing a data block](#choosing-a-data-block) below
  - Files, blobs, uploads, static assets → `FileBucket` (bb-file-bucket)
  - A single config value → `AppSetting` (bb-app-setting)
  - A high-value credential (API key, OAuth secret, connection string) → `Secret` (bb-secret), backed by AWS Secrets Manager
- **Authenticate users**
  - Username/password, prototypes/MVPs → `AuthBasic` (bb-auth-basic)
  - Cognito user pools, MFA, groups → `AuthCognito` (bb-auth-cognito)
  - External identity provider (OIDC) → `AuthOIDC` (bb-auth-oidc)
- **Run work outside the request/response**
  - Fire-and-forget background jobs → `AsyncJob` (bb-async-job)
  - Scheduled / recurring tasks → `CronJob` (bb-cron-job)
- **Push live updates to browsers** (chat, presence, dashboards) → `Realtime` (bb-realtime)
- **Build AI features**
  - Agent with tool use + conversation → `Agent` (bb-agent)
  - Semantic document retrieval (RAG) → `KnowledgeBase` (bb-knowledge-base)
- **Send transactional email** → `EmailClient` (bb-email-client)
- **Serve a raw HTTP endpoint** (webhook receiver, health check, redirect, non-JSON response) → `RawRoute` (core); everything else goes through `ApiNamespace` RPC
- **Observe and operate**
  - Structured logs → `Logger` (bb-logger)
  - Custom metrics → `Metrics` (bb-metrics)
  - Distributed traces → `Tracer` (bb-tracer)
  - Auto CloudWatch dashboard → `Dashboard` (bb-dashboard)

### Choosing a data block

Default to `DistributedTable` for your data models unless your domain specifically requires SQL engine capabilities.

Reach for one of the SQL blocks when you need to filter or join results across more than one related record, filter models on many dimensions with no preset hierarchy, store large objects, require transactions, or otherwise need the flexibility or familiarity of SQL that NoSQL does not offer.

If you need SQL, prefer `DistributedDatabase` for Aurora DSQL, which is PostgreSQL wire-protocol compatible; see the [Aurora DSQL SQL compatibility documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html) for supported SQL features. Use `Database` specifically when you need a full (more expensive) Postgres implementation with row level security, triggers, procedures, or PL/pgSQL functions; large transactions (more than 3,000 rows); or integration with an existing Postgres database. Note it carries an idle cost at minimum 0.5 ACU, or a cold start when scaling from zero, unlike the other two blocks.

## Building Block documentation

Every Building Block ships its docs inside the `@aws-blocks/blocks` package under `docs/<block>/`: each `docs/<block>/` folder contains that block's `README.md`, plus `API.md`, `DESIGN.md`, and `CHANGELOG.md` where present. To read them, locate the bundled folder:

```bash
node -p "require('path').dirname(require.resolve('@aws-blocks/blocks/docs/README.md'))"
```

If resolution fails, fall back to `node_modules/@aws-blocks/blocks/docs`. That folder holds this guide (`README.md`), the framework's own `API.md`, `TROUBLESHOOTING.md`, and `CHANGELOG.md` (version history — read when troubleshooting), plus one subfolder per block; the catalog below lists every block.

<!-- BEGIN:block-catalog -->
| Block | What it does | Keywords |
|-------|--------------|----------|
| auth-common | Shared interfaces and UI components for all AWS Blocks auth Building Blocks. | — |
| bb-agent | AI agent with streaming, tool calling, and conversation persistence. | — |
| bb-app-setting | A single application configuration value backed by SSM Parameter Store. | — |
| bb-async-job | Background job processing backed by SQS, run on Lambda or a container. | queue, job, background, async, worker, submit, batch, retry, status, transitions, SQS |
| bb-auth-basic | Simple username/password authentication with JWT sessions, password policy, and optional code-confirmed signup and password reset. | — |
| bb-auth-cognito | Authentication backed by Amazon Cognito User Pools. | — |
| bb-auth-oidc | OIDC sign-in gate for AWS Blocks applications. | — |
| bb-compute | The `Compute` Building Block is the single surface for choosing where a workload runs. | — |
| bb-cron-job | Scheduled task execution backed by EventBridge Scheduler and Lambda. | cron, schedule, timer, periodic, recurring, rate, EventBridge, background, interval |
| bb-dashboard | Auto-generated CloudWatch Dashboard for application observability. | — |
| bb-data | Full PostgreSQL database — provisions Aurora Serverless v2 by default, or connects to an existing PostgreSQL database (Supabase, Neon, etc.) via `fromExisting()`. | — |
| bb-distributed-data | Serverless SQL database backed by Amazon Aurora DSQL. | — |
| bb-distributed-table | Structured data storage backed by DynamoDB with secondary indexes and rich query capabilities. | — |
| bb-email-client | Transactional email sending via Amazon SES. | — |
| bb-file-bucket | File storage backed by Amazon S3. | — |
| bb-knowledge-base | Semantic document retrieval backed by Amazon Bedrock Knowledge Bases. | — |
| bb-kv-store | Simple key-value storage backed by DynamoDB. | — |
| bb-logger | Structured logging with consistent JSON format, log levels, and contextual metadata. | — |
| bb-metrics | Custom application metrics backed by Amazon CloudWatch (via Embedded Metric Format). | — |
| bb-realtime | Real-time pub/sub messaging backed by API Gateway WebSocket + DynamoDB. | — |
| bb-secret | A single application secret backed by AWS Secrets Manager. | — |
| bb-tracer | Distributed tracing backed by AWS X-Ray. | — |
| core | Core primitives for building full-stack applications with the AWS Blocks. | — |
| hosting | Low-level CDK L3 constructs for deploying web applications on AWS | — |
| pipeline | CDK Pipelines-based CI/CD construct for AWS Blocks applications. | — |
<!-- END:block-catalog -->

## Local development and deploying

| | `npm run dev` | `npm run sandbox` |
|---|---|---|
| Blocks run as | in-memory mocks | real AWS services |
| AWS account | not needed | required |
| Data | persists to `.bb-data/` (delete to reset) | lives in AWS |
| Use for | rapid iteration, tests | pre-production validation against real services |

> **Deploying needs AWS credentials.** `npm run dev` is fully local (no creds). `npm run sandbox` and `npm run deploy` provision real AWS resources, so configure credentials first — e.g. `aws login` (AWS CLI 2.32.0 or later), `aws configure sso` + `aws sso login`, or `aws configure` (verify with `aws sts get-caller-identity`). If the credentials are missing or expired, both commands stop before synthesizing and print the sign-in or refresh command for the profile they use. Use **least-privilege** credentials scoped to the services your blocks deploy — not broad `Administrator` access.

Before they deploy, `npm run sandbox` and `npm run deploy` print the deployment target: the credentials that CDK deploys with (an AWS profile, environment access keys, or container or web identity credentials) and the configured Region. As in CDK, environment access keys are used before `AWS_PROFILE` unless `cdk.json` sets a profile. With valid credentials they also show the account name and the AWS account plan (Free or Paid) when those credentials allow `account:GetAccountInformation` and `freetier:GetAccountPlanState`. Otherwise they show "not available" and continue; these reads never stop a deploy. When you sign in with the AWS-managed role of the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, checked with `iam:GetRole`), the output also links to `https://settings.aws.com/billing` for spend limits. In AWS Settings, verify that the project you intend to manage matches the CLI deployment target before viewing or changing its spend limit. If you sign in with `aws login`, set the profile Region to your project's Region before you sign in (`aws configure set region <region> --profile <name>`), and run `aws login` again if you change it later. `npm run sandbox:destroy` and `npm run destroy` print only the deployment target.

With verified credentials, `npm run sandbox` (including `npm run sandbox:deploy`) and `npm run deploy` also check that CDK has been bootstrapped in that account and Region: they read the SSM parameter `/cdk-bootstrap/<qualifier>/version`, where the qualifier is `@aws-cdk/core:bootstrapQualifier` from the `cdk.json` context, or CDK's default. When the parameter does not exist, they stop before synthesizing and print the command that bootstraps this account and Region, `npx cdk bootstrap aws://<account-id>/<region> --app=`. Run it from the project directory; `--app=` keeps CDK from synthesizing the app first. Bootstrapping is needed once per account and Region, and it creates the `CDKToolkit` CloudFormation stack, including IAM roles that CDK deploys with, so the commands never bootstrap for you. Any other result of the read, such as a denied read or a timeout, does not stop the deploy.

`npm run deploy` does a full production deploy; `npm run sandbox:deploy` deploys the sandbox once and exits (no watch, for scripts and CI); `npm run sandbox:destroy` tears the sandbox down. The same backend code runs in all three — blocks switch implementations automatically.

Importing `@aws-blocks/blocks` through its default (Node) entry declares the default compute (`LambdaCompute`) so the CLI reports it in telemetry. It is folded in only when telemetry reads the registry, after the blocks the app constructed, and an app-constructed `LambdaCompute` takes precedence. The `cdk` and `browser` entries do not declare it.

`npm run deploy` streams CloudFormation events as they happen, so `npm run deploy 2>&1 | tee deploy.log` shows live progress instead of going silent for minutes. Through the `blocks` CLI (`npx --no -- blocks deploy`), the events and other progress go to **stderr**, and stdout keeps the results: the deployment target line, the `BLOCKS_DEPLOYED` line and the final URLs. A deploy failure keeps its reason on **stderr** (that stays the place to grep for why a deploy failed). On POSIX the deploy also survives a stray reap: a single `SIGTERM`, or any `SIGHUP` — a closed terminal, a backgrounded `npm run deploy &` — logs a line and keeps streaming rather than abandoning a stack update CloudFormation is still applying. Press Ctrl-C, or send `SIGTERM` twice, to stop it. That signal resilience is POSIX-only: Windows has no process groups and no OS-delivered `SIGTERM`/`SIGHUP`, so there a kill on the process tree still ends the deploy.

## CLI

`@aws-blocks/blocks` ships the `blocks` command (also installed as `cdk-blocks`). Its version is the installed `@aws-blocks/blocks` version. Run it from anywhere inside an app; it finds the project root by walking up to the `package.json` that has an `aws-blocks/` directory, or from `-C <dir>`. Options follow the command: `npx --no -- blocks dev --port 4000`.

```bash
npx --no -- blocks --help            # grouped command list
npx --no -- blocks help deploy       # help for one command; same as `npx --no -- blocks deploy --help`
npx --no -- blocks --version
```

> Run the command directly as `npx --no -- blocks` (the `--` stops npm from reading `--help` or `--version` as its own options), never a bare `npx blocks` or `npx cdk-blocks`: `--no` uses the CLI installed with `@aws-blocks/blocks` and never downloads a package, while a bare `npx` would install whatever is published under that name (`blocks` on npm is an unrelated package), without asking in CI.

`blocks [global options] <command> [<subcommand>] [arguments] [-- passthrough]`

| Group | Command | Does |
|---|---|---|
| Develop | `blocks dev [--port N] [--no-frontend]` | Run the app locally, with reload; no AWS |
| | `blocks dev stop [--port N] [--all]` | Stop the local dev server this app started |
| | `blocks sandbox` | Deploy your personal sandbox, watch for changes, and run the local server against it |
| | `blocks sandbox deploy` | Deploy the sandbox once and exit (CI) |
| | `blocks sandbox destroy [--yes]` | Delete your sandbox stack; never production |
| | `blocks sandbox console` | Open the AWS console for the sandbox stack |
| Deploy | `blocks deploy [--wait-live[=SECONDS]]` | Deploy the production stack; the target is printed first |
| | `blocks destroy [--yes]` | Delete the production stack, after a confirmation |
| | `blocks whoami` | Show the AWS identity and Region that `deploy` uses (with `.env.production` applied), and the stacks that `sandbox` and `deploy` would affect |
| Configure | `blocks secret set KEY` / `list` / `remove KEY` | Manage secrets; a value is never accepted on the command line |
| | `blocks config set KEY VALUE` / `list` / `remove KEY` | Manage non-secret config |
| | `blocks telemetry [status\|enable\|disable] [--global]` | Show or change telemetry consent |
| Generate | `blocks generate client [foundation] [output]` | Generate the typed client (`aws-blocks/client.js`) |
| | `blocks generate spec [backend] [output]` | Generate the OpenRPC spec |
| | `blocks generate types [--check]` | Generate secret/config key types; `--check` exits 1 when stale |
| Data and blocks | `blocks db <migrate\|status\|generate-types\|pull> [args...]` | Data block operations, forwarded unchanged to the `bb-data` CLI |
| Project | `blocks vendorize <package> [--force]` | Copy a Building Block into the app for customization |
| | `blocks help [command...]` | Help |

The npm-script spellings also work as hidden aliases: `dev:stop`, `sandbox:deploy`, `sandbox:destroy`, `sandbox:console`, `console`, `typegen`, `generate-client`, `spec`, and `cleanup` (`dev stop --all`). `db`, `secret`, `config` and `vendorize` forward every token after their name unchanged, so put global options before the command name. The exception is `-h`/`--help`: anywhere after one of these commands it shows help and never runs the tool with your arguments. For a verb of the tool (`blocks db pull ./out --help`, `blocks help secret remove KEY`), only `<verb> --help` reaches the tool, which prints that verb's usage.

Run `npm run typegen` once and commit `.blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`; until then the check exits 1.

`secret` and `config` take `--stage <name>` with any name; there is no fixed list. A value set with `--stage <name>` is read only by an app whose Hosting `secretStore` (or `configStore`) sets `stage: '<name>'`. Without `--stage`, the value is shared, and every stage falls back to it.

Global options: `-h`/`--help`, `--version`, `-q`/`--quiet`, `-v`/`--verbose`, `--debug`, `--output text|json`, `--query <path>`, `-y`/`--yes`, `--no-input`, `--profile <name>` (sets `AWS_PROFILE`), `--region <region>` (sets `AWS_REGION`) and `-C`/`--cwd <dir>`. The log level is passed to child processes as `BLOCKS_LOG_LEVEL=quiet|normal|verbose|debug`.

### Output and exit codes

Results go to stdout; progress, warnings and errors go to stderr. In text mode the CLI runs core with `BLOCKS_LOG_STREAM=stderr`: core's progress lines, the CDK milestones, raw CDK output (`--verbose`/`--debug`) and the streamed CloudFormation events go to stderr, while the result lines — `🎯 Deployment target: …`, `BLOCKS_DEPLOYED …` and the final URLs — stay on stdout. Without `BLOCKS_LOG_STREAM` (core's scripts called directly) the streams are as before. With `--output json`, stdout carries exactly one JSON document and all output of CDK and other child tools moves to stderr; after a failed or interrupted deploy no result is printed. `blocks deploy` and `blocks sandbox deploy` print `{apiUrl, url, stack, account, region}`, where the account and Region are the ones the deploy itself used (it loads `.env.production` or `.env.local`); `blocks whoami` prints `{account, arn, credentials, region, projectRoot, stacks: {sandbox, production}}`; `blocks dev stop` prints `{stopped: [...]}`. Arguments after `--` are an error (exit 2) except for `db`, `secret`, `config` and `vendorize`, which forward them.

`--query <path>` prints one field of that result, raw: a string without quotes, `null` as an empty line, and an object as JSON. An unknown path exits 2 before the command runs.

```bash
API_URL=$(npx --no -- blocks deploy --query apiUrl)
npx --no -- blocks whoami --query stacks.production
```

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | The operation failed |
| 2 | Usage error: unknown command or option, missing argument, or a confirmation that a non-interactive run cannot give |
| 130 | Interrupted (Ctrl-C) |

Errors print as `Error: <what failed>`, then where it failed and a `Try:` line with the next step. An unknown command or option suggests the closest name. Colour is used only on a terminal, and never when `NO_COLOR` is set.

`blocks destroy` prints the stack it deletes, then asks for confirmation in a terminal. Without a terminal (no TTY, `--no-input`, or `CI` set) it needs `--yes`, and exits 2 otherwise: `npx --no -- blocks destroy --yes`.

### Per-app configuration

`blocks dev` and `blocks sandbox` read the local server settings from `package.json` under `"blocks"`:

```json
{
  "blocks": {
    "dev": { "port": 3000, "frontendCommand": "npx vite --port 3100 --strictPort", "frontendPort": 3100 }
  }
}
```

`port` is the port you open in the browser; it serves the app and proxies the frontend dev server, which listens on the internal `frontendPort` (default `3100`). `host` sets the interface to bind (default `127.0.0.1`). Without `frontendCommand`, the frontend is detected from the app's dependencies and started on `frontendPort`: `next` runs `npx next dev --webpack --hostname 127.0.0.1 --port <frontendPort>`, `vite` runs `npx vite --port <frontendPort> --strictPort`, and neither runs the backend only. A `frontendCommand` you set must listen on `frontendPort` itself. Flags override both: `npx --no -- blocks dev --port 4000` serves the app on http://localhost:4000.

The lifecycle commands run the app's TypeScript with `tsx`, as the generated npm scripts do. The CLI uses the app's own `tsx` when it is installed, and otherwise the one that `@aws-blocks/blocks` depends on. Client generation (`blocks generate client`, and the client step of `blocks deploy` and `blocks sandbox`) loads the same `tsx`, so an app without its own `tsx` works with pnpm or a non-hoisted npm install too.

## Testing

The fastest loop is calling your API through its typed import in `test/e2e.test.ts` — no browser, no mocking:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import type { api as ApiType } from 'aws-blocks';

let api: typeof ApiType;
test.before(async () => { api = (await import('aws-blocks')).api; });

test('stores and reads back a value', async () => {
  await api.setValue('k', 'v');
  assert.equal(await api.getValue('k'), 'v');
});
```

Run with `npm run test:e2e`. Write the test first, iterate against mocks until it passes.

## Best practices

- **Export every API** — the frontend can only import what you `export` from `aws-blocks/index.ts`.
- **Validate with schemas** — pass a Zod/Valibot schema to data blocks for compile-time *and* runtime type safety.
- **Don't block the request** — use `AsyncJob` for anything slow; `submit()` returns a `jobId` immediately.
- **Guard against races** — use conditional writes (`ifNotExists`, `ifValueEquals`, `ifFieldEquals`) instead of read-modify-write.
- **Test locally first** — mocks behave like the real service; deploy once it's green.

## Common mistakes

- **Ungated endpoints** — methods are public unless you call `requireAuth`/`requireRole`. The local mock won't catch this for you.
- **Forgetting to export** — an `ApiNamespace` you don't export is invisible to the frontend.
- **`Database` when `DistributedTable` would do** — Aurora costs more and has cold starts; reach for SQL only when you need it.
- **Curling REST-style paths** — there is no `GET /api/getData`. All calls are JSON-RPC `POST`s under `/aws-blocks/api`; use the typed import instead.

## Security Considerations

- Use `await auth.requireAuth(context)` in every method that shouldn't be public — ApiNamespace methods are **unauthenticated by default**
- Use `new Secret(scope, id)` for API keys and credentials — `Secret` is the recommended home for production secrets. `new AppSetting(scope, id, { secret: true })` is a free, encrypted fallback only for a low-value secret. Don't hardcode secret values in source, and don't ship real secrets to a deployed app through plaintext environment variables — set them through `Secret`/`AppSetting`
- Always attach a schema to KVStore/AppSetting that accepts user data — the RPC layer validates structure but not business logic
- Do not add broad `*` IAM policies — each Building Block already grants least-privilege scoped to its own resources
- Never change `blockPublicAccess` on FileBucket — serve public files through CloudFront instead
- Configure `defaults.allowedOrigins` explicitly for production — avoid wildcards
- `defaults.allowedOrigins` covers the API only — a FileBucket whose presigned URLs or file handles are fetched from the browser needs its own `corsRules` listing your frontend origins (including `http://localhost:3000` for a local frontend against a sandbox), or uploads/downloads fail with a CORS error once deployed
- For cross-domain deployments, pass `crossDomain: true` to auth constructors (enables `SameSite=None; Secure; Partitioned`)
- Enable `frontDoor: { features: { monitoring: { enabled: true, subscriptions: [new subs.EmailSubscription('oncall@example.com')] } } }` on Hosting for production alerts (`subs` = `aws-cdk-lib/aws-sns-subscriptions`; email/URL only; the top-level `monitoring` prop is its deprecated alias)
- Add WAF and API Gateway throttling via CDK for public-facing apps — not included by default
- Logger provides serialization safety (circular refs, type coercion) but does NOT redact sensitive content — never pass raw credentials, tokens, or secrets to Logger methods; sanitize context objects before logging

### IAM hardening

Every Blocks compute runs as one shared IAM (Identity and Access Management) execution role, and every Building Block grants its permissions onto it. Set `defaults.permissionsBoundary` to attach a [permissions boundary](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html), a ceiling on effective permissions, to every IAM role AWS Blocks creates. Pass the policy's name, its full ARN (required when the policy has a path), or an `iam.IManagedPolicy`. It's unset in both presets, and unset leaves templates unchanged.

```typescript
// aws-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' },
});
```

- **Report.** Every synth, with or without a boundary, writes the shared role's composed policy to `cdk.out/<stack>.blocks-iam.json` (`<stack>.<backendId>.blocks-iam.json` for an embedded `BlocksBackend`); it isn't deployed, so CI can diff it to catch permission growth.
- **Scope.** On a `BlocksStack` the boundary covers every role in the stack; on an embedded `BlocksBackend` it covers the backend's subtree plus the stack-level CDK (Cloud Development Kit) singleton roles its blocks add.
- **CDK context.** If CDK's `@aws-cdk/core:permissionsBoundary` context is also set, `defaults.permissionsBoundary` wins for the roles Blocks creates and synth warns.

Details, including sharing one AWS account across many apps, are in the bundled `@aws-blocks/core` README (`docs/core/README.md`), sections "IAM: permissions boundary and the composed-policy report" and "Running many apps in one AWS account (a shared platform)".

## VPC Support

AWS Blocks supports running your backend in a VPC for network-level isolation or to connect to VPC-bound resources. You can let Blocks manage endpoint provisioning and security groups automatically, or bring a fully-configured VPC and handle networking yourself.

See [VPC.md](./VPC.md) for usage, configuration options, cost details, and guidance on when a VPC is appropriate.

## Reference

- **Per-block documentation:** `docs/<block>/README.md` (overview), plus `docs/<block>/API.md` (full API reference) and `docs/<block>/DESIGN.md` (architecture & rationale) where present — e.g. `docs/bb-distributed-table/README.md`. The catalog + decision tree live in `docs/README.md`.
- **UI components** (`@aws-blocks/blocks/ui`): `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, `broadcastAuthChange` — framework-agnostic, return DOM nodes. See the `@aws-blocks/auth-common` README.
- **SSR** (`@aws-blocks/blocks/server`): `withAuth` forwards browser cookies to API calls during server rendering. See the `@aws-blocks/core` README.
- **Wire protocol & debugging:** the client is JSON-RPC 2.0 under `/aws-blocks/api` — you should never call it directly. For `curl`-level troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
