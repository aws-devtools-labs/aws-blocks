# AWS CDK Blocks

AWS CDK Blocks is a backend framework built from **Building Blocks**: self-contained modules that each bundle a CDK construct, its AWS SDK integration, and a local mock. You compose blocks in one directory, export an API, and call it from your frontend with end-to-end type safety.

This package (`aws-cdk-blocks`) re-exports every Building Block and the core primitives, so you import everything from one place:

```typescript
import { Scope, ApiNamespace, KVStore, Auth } from 'aws-cdk-blocks';
```

## Quick start

```bash
npx @aws-cdk-blocks/create-blocks-app my-app
cd my-app
npm run dev          # → http://localhost:3000  (mocks, no AWS account needed)
```

`--template <name>` picks a starter (`react`, `nextjs`, `backend`, …); see [`@aws-cdk-blocks/create-blocks-app`](https://www.npmjs.com/package/@aws-cdk-blocks/create-blocks-app).

## How it works

Your entire backend lives in one directory, `cdk-blocks/`. You create blocks, then expose methods through an `ApiNamespace`:

```typescript
// cdk-blocks/index.ts
import { Scope, ApiNamespace, KVStore } from 'aws-cdk-blocks';

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

The frontend imports that API and calls it as a function:

```typescript
// src/
import { api } from 'cdk-blocks';

await api.setValue('greeting', 'hello');
const value = await api.getValue('greeting'); // typed: string | null
```

Calls travel as JSON-RPC `POST`s under `/cdk-blocks/api`. Use the typed import: there are no REST paths such as `GET /api/getValue`.

## Adding auth and data

The same API with sign-in and a queryable store:

```typescript
// cdk-blocks/index.ts
import { Scope, ApiNamespace, Auth, KVStore } from 'aws-cdk-blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

const auth = new Auth(scope, 'auth', { emailPassword: { passwordPolicy: { minLength: 8 } } });

const notes = new KVStore(scope, 'notes', {
  schema: z.object({ userId: z.string(), noteId: z.string(), text: z.string() }),
  key: { partitionKey: 'userId', sortKey: 'noteId' },
});

// Sign-up / sign-in endpoints, ready to wire to the frontend
export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async addNote(text: string) {
    const user = await auth.requireAuth(context);          // 401s if not signed in
    const noteId = crypto.randomUUID();
    await notes.put({ userId: user.userSub, noteId }, { text });
    return { noteId };
  },
  async listNotes() {
    const user = await auth.requireAuth(context);
    const entries = await Array.fromAsync(notes.query({ where: { userId: { equals: user.userSub } } }));
    return entries.map((entry) => entry.value);
  },
}));
```

> **Security:** every `ApiNamespace` method is a public internet endpoint with **no auth by default**. Start protected methods with `await auth.requireAuth(context)` or `await auth.requireRole(...)`. Test that signed-out calls fail; without a guard the local mock and deployed backend both allow the call.

On the frontend, `aws-cdk-blocks/ui` gives you provider-agnostic auth components, or drive `authApi` yourself:

```typescript
import { Authenticator, onAuthChange } from 'aws-cdk-blocks/ui';
import { authApi, api } from 'cdk-blocks';

document.body.append(Authenticator(authApi));
onAuthChange(authApi, (user) => {
  if (user) api.listNotes().then(render);
});
```

A frontend served from another origin than the API signs in with a federated provider through `createAuthClient()` from the same entry: see `@aws-cdk-blocks/bb-auth`'s README, *Frontend on a different origin*.

## Building Blocks

- **Store data**
  - Values that you read by one key (caches, flags, user preferences) → `KVStore` (bb-kv-store) with no options
  - Records that you list or query, with indexes → `KVStore` (bb-kv-store) with a `schema` and a `key` — **default for most data**
  - Relational / SQL (joins, transactions) → `Database` (bb-database); see [Choosing a data block](#choosing-a-data-block) below
  - Files, blobs, uploads, static assets → `FileBucket` (bb-file-bucket)
  - A single config value → `AppSetting` (bb-app-setting)
  - A high-value credential (API key, OAuth secret, connection string) → `Secret` (bb-secret), backed by AWS Secrets Manager
- **Authenticate users** → `Auth` (bb-auth) — one block; `store` picks where users live, and every sign-in provider is a `providers` entry with a `type` (see [Choosing a sign-in method](#choosing-a-sign-in-method) below)
  - Your own users with email + password (the default) → `new Auth(scope, 'auth')`
  - Google, Apple, Facebook or Amazon sign-in → `providers: { google: { type: 'google', … } }`
  - Okta, Entra ID, Auth0, GitHub or any OIDC provider, verified by your backend → `store: 'builtin'` with `type: 'oidc'` entries (or `github()`)
  - An identity provider that only speaks SAML → `type: 'saml'`
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

Use `KVStore` unless you need SQL. Choose its form (with or without a `schema` and a `key`, see the list above) before you create the store: a store cannot change its key.

Use `Database` when you need joins or filters across related records, filters on many fields with no fixed key hierarchy, multi-row transactions, or large objects.

`Database` runs on Aurora DSQL by default, which is PostgreSQL wire-protocol compatible; see the [Aurora DSQL SQL compatibility documentation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html) for supported SQL features. For triggers, extensions, PL/pgSQL functions, Row Level Security on raw SQL or transactions over 3,000 rows, put the block on an `aurora` cluster (`new DatabaseCluster(scope, 'main', { type: 'aurora' })`, Aurora PostgreSQL Serverless v2). An `aurora` cluster pauses when idle unless `minCapacity` is at least `0.5`: `npm run docs Database` has the cluster options and their cost.

### Choosing a sign-in method

First pick where the users live: in a Cognito user pool (the default store), or at their identity provider with `store: 'builtin'` (no user pool). One block holds one kind of user, so password users and backend-verified OIDC users need two `Auth` blocks. The methods differ in cost and in where they run:

| Method | Configure with | Works offline in `npm run dev` | User-pool user (Cognito groups, `auth.admin`) |
|---|---|---|---|
| Email + password | `emailPassword` (on by default; default store) | Yes | Yes |
| Social | `providers` entry, `type: 'google'` / `'apple'` / `'facebook'` / `'amazon'` (default store) | No — deploy a sandbox to test | Yes |
| OIDC, verified by your backend | `store: 'builtin'`, `type: 'oidc'` entry | Yes, with `stubIdp()` | No — groups come from the IdP's token |
| OIDC through Cognito | `type: 'oidc'` entry on the default store | No | Yes |
| SAML | `type: 'saml'` entry (default store) | No | Yes |

Cost: email + password and social users share the user pool's free tier. OIDC through Cognito and SAML users are metered separately, with a smaller free tier. `store: 'builtin'` users have no Cognito charge.

MFA and passkeys apply only to email + password users; federated users get MFA from their identity provider. Only `store: 'builtin'` supports PKCE-only (public) clients. For prices, the full comparison and how to choose, read *Which option and why* in the `Auth` README (`npm run docs Auth -- --section "which option"`).

## Building Block documentation

Run `npm run docs` in the app to list the Building Blocks shipped with its installed version of `aws-cdk-blocks`. `npm run docs KVStore` reads a block's README; `npm run docs:api KVStore` reads its API report. Look up an export such as `ApiError` or `ifFieldEquals` for its import line, declaration and docs, or run `npm run docs:search "sign in"` to search across the docs. `npm run docs -- --help` lists the other options.

<!-- BEGIN:block-catalog -->
| Block | What it does | Keywords |
|-------|--------------|----------|
| auth-common | Shared interfaces and UI components for AWS CDK Blocks authentication: the `BlocksAuth` contract that `Auth` implements, the `AuthErrors` vocabulary, and the provider-agnostic sign-in UI. | — |
| bb-agent | AI agent with streaming, tool calling, and conversation persistence. | — |
| bb-app-setting | A single application configuration value backed by SSM Parameter Store. | — |
| bb-async-job | Background job processing backed by SQS, run on Lambda or a container. | queue, job, background, async, worker, submit, batch, retry, status, transitions, SQS |
| bb-auth | `Auth` is the single authentication Building Block for AWS CDK Blocks: one import and one options object for email + password, social sign-in, generic OIDC and SAML. | — |
| bb-compute | The `Compute` Building Block selects where a workload runs: `type: 'serverless'` (AWS Lambda) or `type: 'container'` (AWS Fargate). | — |
| bb-cron-job | Scheduled task execution backed by EventBridge Scheduler and Lambda, or a container compute for long-running jobs. | cron, schedule, timer, periodic, recurring, rate, EventBridge, background, interval |
| bb-dashboard | Auto-generated CloudWatch Dashboard for application observability. | — |
| bb-database | `Database` is a PostgreSQL schema on a cluster: Aurora DSQL by default, or Aurora PostgreSQL Serverless v2 created with the express configuration. | — |
| bb-email-client | Transactional email sending via Amazon SES. | — |
| bb-file-bucket | File storage backed by Amazon S3. | — |
| bb-knowledge-base | Semantic document retrieval backed by Amazon Bedrock Knowledge Bases. | — |
| bb-kv-store | Key-value and document storage backed by DynamoDB, with optional secondary indexes. | — |
| bb-logger | Structured logging with consistent JSON format, log levels, and contextual metadata. | — |
| bb-metrics | Custom application metrics backed by Amazon CloudWatch (via Embedded Metric Format). | — |
| bb-realtime | Real-time pub/sub messaging backed by API Gateway WebSocket + DynamoDB. | — |
| bb-secret | A single application secret backed by AWS Secrets Manager. | — |
| bb-tracer | Distributed tracing backed by AWS X-Ray. | — |
| core | Core primitives for building full-stack applications with AWS CDK Blocks. | — |
| hosting | Low-level CDK L3 constructs for deploying web applications on AWS | — |
| pipeline | CDK Pipelines-based CI/CD construct for AWS CDK Blocks applications. | — |
<!-- END:block-catalog -->

## Testing

Test the API through its typed import in `test/e2e.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import type { api as ApiType } from 'cdk-blocks';

let api: typeof ApiType;
test.before(async () => { api = (await import('cdk-blocks')).api; });

test('stores and reads back a value', async () => {
  await api.setValue('k', 'v');
  assert.equal(await api.getValue('k'), 'v');
});
```

Run with `npm run test:e2e`. Write the test first, iterate against mocks until it passes.

Test helpers come from `aws-cdk-blocks/utils`. The entry is Node only: tests and scripts, including the templates' `tsx -C browser` e2e tests, since the entry has no `browser` condition. Do not import it in browser bundles.

| Helper | Use |
|---|---|
| `installCookieJar(): () => void` | Keeps `Set-Cookie` across `fetch` calls, so a signed-in session persists between API calls. Call it once before `await import('cdk-blocks')`. It returns a function that restores `fetch`. |
| `createTestClient(clients)` | Returns the same typed clients bound to a cookie jar of their own, for several signed-in users in one test. |
| `getLastAuthCode(username, options?): Promise<string>` | Reads the verification code the local `Auth` pool last sent (local only). |
| `totpCodeFor(sharedSecret, time?): string` | Computes an authenticator-app (TOTP) code. |
| `isServerRunning(port = 3000): Promise<boolean>` | Checks whether a dev server is already listening, so test setup can skip starting one. |

## Best practices

- **Export every API** — the frontend can only import what you `export` from `cdk-blocks/index.ts`.
- **Validate with schemas** — pass a Zod/Valibot schema to data blocks for compile-time *and* runtime type safety.
- **Don't block the request** — use `AsyncJob` for anything slow; `submit()` returns a `jobId` immediately.
- **Guard against races** — use conditional writes (`ifNotExists`, `ifValueEquals`, `ifFieldEquals`) instead of read-modify-write.
- **Test locally first** — mocks implement the same API as the real service, but not every AWS behavior (limits, TTL expiry, IAM, partial failures); check the mock-vs-AWS differences in a block's `DESIGN.md` where it has one. Deploy to a sandbox once it's green.

## Security Considerations

- Keep API keys and credentials in `Secret` (`new Secret(scope, id)`). `new AppSetting(scope, id, { secret: true })` is a free, encrypted fallback only for a low-value secret. Do not hardcode secret values in source, and do not pass real secrets to a deployed app through plaintext environment variables
- Always attach a schema to KVStore/AppSetting that accepts user data — the RPC layer validates structure but not business logic
- Do not add broad `*` IAM policies — each Building Block already grants least-privilege scoped to its own resources
- Never change `blockPublicAccess` on FileBucket — serve public files through CloudFront instead
- Configure `defaults.allowedOrigins` explicitly for production — avoid wildcards. List plain origins such as `'https://app.example.com'` (matched exactly); in a regex entry, escape every dot (`'https://app\\.example\\.com'`) — invalid regex entries fail `cdk synth`
- `defaults.allowedOrigins` covers the API only — a FileBucket whose presigned URLs or file handles are fetched from the browser needs its own `corsRules` listing your frontend origins (including `http://localhost:3000` for a local frontend against a sandbox), or uploads/downloads fail with a CORS error once deployed
- For cross-domain deployments, pass `session: { crossDomain: true }` to `Auth` (enables `SameSite=None; Secure; Partitioned`)
- Enable `frontDoor: { features: { monitoring: { enabled: true, subscriptions: [new subs.EmailSubscription('oncall@example.com')] } } }` on Hosting for production alerts (`subs` = `aws-cdk-lib/aws-sns-subscriptions`; email/URL only; the top-level `monitoring` prop is its deprecated alias)
- WAF is off by default. On the default `apiFrontDoor: 'apigateway'` tier, set `apiWaf: { enabled: true }` on `BlocksStack` or `BlocksBackend` to protect the gateway stage.
- To protect traffic through a `Hosting` CloudFront distribution, set `frontDoor: { features: { waf: { enabled: true } } }` on `Hosting`. This does not cover direct calls to the gateway. On the `'cloudfront'` tier, put the ACL on Hosting when it serves the API; otherwise configure the managed distribution with `apiWaf: { enabled: true }` (in `us-east-1`), or pass `apiWaf: { webAclArn }` for an existing CloudFront ACL. See `npm run docs core` for regional requirements and rate limits.
- API Gateway throttling is on by default (`defaults.throttling`). It does not cover container routes served directly by CloudFront.
- Logger provides serialization safety (circular refs, type coercion) but does NOT redact sensitive content — never pass raw credentials, tokens, or secrets to Logger methods; sanitize context objects before logging

### IAM hardening

Every Blocks compute runs as one shared IAM execution role, and every Building Block grants its permissions onto it. Set `defaults.permissionsBoundary` to attach a [permissions boundary](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html), a ceiling on effective permissions, to every IAM role AWS CDK Blocks creates. Pass the policy's name, its full ARN (required when the policy has a path), or an `iam.IManagedPolicy`. It's unset in both presets, and unset leaves templates unchanged.

```typescript
// cdk-blocks/index.cdk.ts
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' },
});
```

Every synth writes the shared role's composed policy to `cdk.out/<stack>.blocks-iam.json` (`<stack>.<backendId>.blocks-iam.json` for an embedded `BlocksBackend`); it isn't deployed, so CI can diff it to catch permission growth. See `npm run docs core` for permissions boundary scope and shared-account guidance. For shared-account policies, pipeline setup, and adoption steps, run `npm run docs core/SHARED-ACCOUNT.md` (`docs/core/SHARED-ACCOUNT.md` in the installed package).

## VPC Support

AWS CDK Blocks supports running your backend in a VPC for network-level isolation or to connect to VPC-bound resources. You can let Blocks manage endpoint provisioning and security groups automatically, or bring a fully-configured VPC and handle networking yourself.

See [VPC.md](./VPC.md) for usage, configuration options, cost details, and guidance on when a VPC is appropriate.

## Local development and deploying

| | `npm run dev` | `npm run sandbox` |
|---|---|---|
| Blocks run as | in-memory mocks | real AWS services |
| AWS account | not needed | required |
| Data | persists to `.cdk-blocks/local/data/` (delete to reset) | lives in AWS |
| Use for | rapid iteration, tests | pre-production validation against real services |
| On a file change | the server reloads | a code-only change is hotswapped into the deployed functions in seconds; a change that needs new or changed infrastructure (for example adding a `Database` or `Realtime`) runs a full deploy of the stack, which takes minutes |

### AWS credentials

`npm run dev` needs no AWS credentials. `npm run sandbox` and `npm run deploy` create AWS resources and need them.

- Configure credentials with `aws login` (AWS CLI 2.32.0 or later), `aws configure sso` + `aws sso login`, or `aws configure`. Verify them with `aws sts get-caller-identity`.
- Use least-privilege credentials scoped to the services your app deploys, not broad `Administrator` access.
- If the credentials are missing or expired, both commands stop before synthesizing and print the sign-in or refresh command for the profile they use, with that profile and the deployment Region.
- When the fix is `aws login` and the profile has no Region or another one, they first print `aws configure set region <region> --profile <name>`, so that you sign in to the Region you deploy to. After a later Region change, sign in again.
- When `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region, the printed `aws login` includes `--region <region>`.
- If AWS denies the credentials check, for example because an AWS Organizations policy explicitly denies it, they warn and continue, and the deploy reports any error.

### Deployment target

Before they deploy, `npm run sandbox` and `npm run deploy` print the deployment target and continue without a pause. If the target is not the one you expect, stop the command with Ctrl-C.

- The target is the credentials that CDK deploys with (an AWS profile, environment access keys, or container or web identity credentials) and the configured Region.
- As in CDK, environment access keys are used before `AWS_PROFILE` unless `cdk.json` sets a profile.
- With valid credentials the commands also show the account name and the AWS account plan (Free or Paid) when those credentials allow `account:GetAccountInformation` and `freetier:GetAccountPlanState`. Otherwise they show "not available" and continue.
- When you sign in with the AWS-managed role of the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, checked with `iam:GetRole`), the output also links to `https://settings.aws.com/billing` for spend limits. In AWS Settings, verify that the project you intend to manage matches the CLI deployment target before viewing or changing its spend limit.
- `npm run sandbox:destroy` and `npm run destroy` print only the deployment target.

### CDK bootstrap

- With verified credentials, `npm run sandbox`, `npm run sandbox:deploy` and `npm run deploy` check that CDK is bootstrapped in the account and Region. They read the SSM parameter `/cdk-bootstrap/<qualifier>/version`, where the qualifier is `@aws-cdk/core:bootstrapQualifier` from the `cdk.json` context, or CDK's default.
- When the parameter does not exist, deploy stops before synthesizing. Copy the bootstrap command it prints, including `--profile` if present, and run it from the project directory. `--app=` keeps CDK from synthesizing the app first.
- Bootstrapping is needed once per account and Region. It creates the `CDKToolkit` CloudFormation stack, including IAM roles that CDK deploys with, so the commands never bootstrap for you.
- Any other result of the read, such as a denied read or a timeout, does not stop the deploy.

### Deploy progress and signals

- `npm run deploy` streams CloudFormation events as they happen: `npm run -s deploy -- --output text 2>&1 | tee deploy.log` shows live progress.
- In text mode, the events and other progress go to stderr. stdout keeps the results: the deployment target line, the `BLOCKS_DEPLOYED` line and the final URLs.
- A deploy failure prints its reason on stderr: grep there for why a deploy failed.
- To stop a deploy, press Ctrl-C or send `SIGTERM` twice.
- On POSIX, a single `SIGTERM` or any `SIGHUP` (a closed terminal, a backgrounded `npm run deploy &`) logs a line and the deploy keeps streaming, so a stack update that CloudFormation is still applying is not abandoned. On Windows, a kill on the process tree ends the deploy.

## Package scripts

Run tasks from your app with its package manager. `npm run` lists the scripts in its `package.json`; `npm run help` describes the Blocks tasks. Each script loads the runner, `aws-cdk-blocks/run`, from the app's installed `aws-cdk-blocks`: there is no separate CLI to install. Do not import `/run` from application code. For an older app, see [Migrating an existing app](#migrating-an-existing-app).

With npm, put positional arguments directly after the task name. Use `--` before options that belong to the task, so npm does not consume them. For a pipe, redirect or command substitution, add `-s` to suppress npm's script banner:

```bash
npm run help deploy                         # help for one task
npm run docs Auth KVStore                   # two positional names
npm run docs Auth -- --section "which option"
npm run dev -- --port 4000
npm run -s docs:api KVStore | jq -r '.docs[0].text'
```

With another package manager, use its script runner (for example, `pnpm run docs KVStore` or `bun run docs KVStore`) and its argument-forwarding syntax.

| Group | App script | Purpose |
|---|---|---|
| Develop | `npm run dev` | Run locally with reload and mocks; add `-- --no-frontend` to run just the backend |
| | `npm run dev:stop` / `npm run cleanup` | Stop the local server, or all dev servers this app recorded |
| | `npm run sandbox` | Deploy your sandbox, watch for changes and run the local server against it |
| | `npm run sandbox:deploy` / `npm run sandbox:preview` | Deploy once and exit; preview also hosts the frontend and prints its URL |
| | `npm run sandbox:destroy` / `npm run sandbox:console` | Delete the sandbox (never production), or open its AWS console |
| | `npm run docs [name...]` | Read the installed docs, including an export, option or `Owner.member`. A document's `<folder>/<file>` is also a lookup name, e.g. `npm run docs bb-kv-store/README.md` |
| | `npm run docs:api KVStore` / `npm run docs:search "sign in"` | Read a block's API report or search the docs |
| Deploy | `npm run deploy` / `npm run destroy` | Deploy or delete the production stack. Deploy prints its target first; destroy requires confirmation |
| | `npm run whoami` | Show the AWS identity and Region that deploy uses (with `.env.production` applied), and the affected sandbox and production stacks |
| Configure | `npm run secret set KEY` / `npm run config set KEY VALUE` | Manage secrets or non-secret config. Both support `list` and `remove KEY`; a secret value is never accepted on the command line |
| Generate | `npm run generate-client [foundation] [output]` / `npm run spec [backend] [output]` | Generate the typed client (`cdk-blocks/client.js`) or the OpenRPC spec |
| | `npm run typegen` | Generate secret/config key types; add `-- --check` to exit 1 when stale |
| Data and blocks | `npm run db <verb> [args...]` | Run `connect`, `migrate`, `types` or `status` with `bb-database`. Use `--block <id>` with `types` or `status` for a provisioned cluster |
| | `npm run vendorize <package>` | Copy a Building Block into the app for customization |
| Project | `npm run migrate` | Update an existing app's task scripts; add `-- --dry-run` to preview |
| | `npm run help [task]` | Show help without running the task |

`db`, `secret`, `config` and `vendorize` forward arguments to their underlying tools:

- Global options apply to the runner: `npm run secret list -- --profile prod` lists the secrets of that profile's account.
- `config` has no JSON output: `npm run config list -- --output json` exits 2.
- To pass a literal option-like value to the tool, use a second `--` for the runner: `npm run config set GREETING -- -- -hello-`.
- To show one verb's help without running it, use `npm run db -- connect --help` or `npm run help secret remove`.
- For the database tool's own JSON, use `npm run -s db -- status -- --output json`.

For every other task, arguments after a literal `--` passed to the runner are an error (exit 2), except for `docs`, which reads them as names.

Run from the app directory when supplying relative paths to `db`, `generate-client`, `spec` or `typegen`: npm runs scripts from the package root.

Run `npm run typegen` once and commit `.cdk-blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`; until then the check exits 1.

`secret` and `config` take `--stage <name>` with any name; there is no fixed list. A value set with `--stage <name>` is read only by an app whose Hosting `secretStore` (or `configStore`) sets `stage: '<name>'`. Without `--stage`, the value is shared, and every stage falls back to it.

### Global options

- `-h`/`--help`: show help.
- `--version`: print the `aws-cdk-blocks` version.
- `-q`/`--quiet`, `-v`/`--verbose`, `--debug`: set the log level, which is passed to child processes as `BLOCKS_LOG_LEVEL=quiet|normal|verbose|debug`.
- `--output text|json` and `--query <path>`: see [Output and exit codes](#output-and-exit-codes).
- `-y`/`--yes`: assume yes for confirmations.
- `--no-input`: never prompt.
- `--profile <name>` (sets `AWS_PROFILE`) and `--region <region>` (sets `AWS_REGION`).
- `-C`/`--cwd <dir>`: run as if started in that directory.
- `--telemetry-file <path>` (also `--telemetry-file=<path>`): also write the run's telemetry events to that file, for example `npm run dev -- --telemetry-file=/tmp/events.json`. This applies to every command. A relative path is resolved from the directory you run the command in.

### Telemetry

Importing `aws-cdk-blocks` through its default (Node) entry declares the default compute (`LambdaCompute`) so the CLI reports it in telemetry. It is folded in only when telemetry reads the registry, after the blocks the app constructed, and an app-constructed `LambdaCompute` takes precedence. The `cdk` and `browser` entries do not declare it.

The runner collects usage data to improve AWS CDK Blocks and prints a notice the first time it does.

- Telemetry follows the CDK CLI setting. Set `CDK_DISABLE_CLI_TELEMETRY=1` to opt out for commands that inherit it, or set `cli-telemetry: false` in the `context` of `~/.cdk.json` for a user-wide default.
- For one app, run `npx cdk cli-telemetry --disable` from the app directory, or set `cli-telemetry: false` in the `context` of its `cdk.json`. DNS filtering and `--no-version-reporting` stop CDK's own telemetry only. See [CDK telemetry opt-out](https://docs.aws.amazon.com/cdk/v2/guide/cli-telemetry.html#telemetry-opt-out).
- Pass `--telemetry-file <path>` to inspect the events a run records when telemetry is enabled.

An event can include:

- random installation and project IDs, and an event ID and timestamp
- the command, its outcome, duration and error category (never the error message)
- your OS, Node.js version and package manager user agent
- whether it ran in CI or under a coding agent
- the AWS CDK Blocks and CDK versions, the framework, and the template name and version
- the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses, and how many of them are custom (custom Building Block names are never sent)

The runner does not collect source files or ask for personal identifiers. The package manager user agent and template metadata are included as supplied: keep personal information, paths and secrets out of custom values. As with any HTTPS request, the collection endpoint also receives your IP address. It is not stored, except in logs of requests that the endpoint's firewall blocks. Events are kept for up to 1 year, and logs of all requests, blocked or not, for up to 10 years.

### Output and exit codes

- Tasks with a structured result (including `docs`, `dev:stop`, `sandbox:deploy`, `sandbox:preview`, `deploy`, `whoami` and `migrate`) default to text on a terminal and JSON when stdout is piped, redirected or captured. `--output text` and `--output json` override that choice.
- Help and version default to text, and tasks without structured results do not switch to JSON.
- Results go to stdout; progress, warnings and errors go to stderr.
- In text mode, the result lines (`🎯 Deployment target: …`, `BLOCKS_DEPLOYED …` and the final URLs) are on stdout. The progress lines, the CDK milestones, raw CDK output (`--verbose`/`--debug`) and the streamed CloudFormation events are on stderr.
- In JSON mode, stdout carries exactly one JSON document and all output of CDK and other child tools moves to stderr. After a failed or interrupted deploy no result is printed.

| Task | JSON result |
|---|---|
| `npm run deploy`, `npm run sandbox:deploy` | `{apiUrl, url, stack, account, region}`. The account and Region are the ones the deploy itself used (it loads `.env.production` or `.env.local`) |
| `npm run deploy` | Adds `live`: `true` when `--wait-live` confirmed the new build; `false` when its wait failed (the deploy succeeded, the result is printed, and the command exits 1); `null` otherwise |
| `npm run whoami` | `{account, arn, credentials, region, projectRoot, stacks: {sandbox, production}}` |
| `npm run dev:stop` | `{stopped: [{port, stopped, alreadyStopped, portFree, via, holders}, …]}`. `holders` lists the `{pid, command}` of each process still holding a port that was not stopped |

`npm run docs` displays Markdown on a terminal. To save Markdown rather than JSON, use `npm run -s docs KVStore -- --output text > kv-store.md`. Errors stay text on stderr, with the same exit codes. In a JSON result, each doc is named by `doc`, its `<folder>/<file>` (`bb-kv-store/README.md`):

| `npm run docs` call | JSON result |
|---|---|
| No name (the listing) | `{version, blocks: [{name, classes, summary, doc, files}], framework: [{name, summary, doc}]}` |
| A block, or `--section` | `{docs: [{doc, section, lines, text}]}`, with the Markdown as `text` and `lines` as `[first, last]` |
| A name | `{name, kind, package, import, declaration, summary, docs}` |
| `--exports` | `{names: [{name, kind, package, entry, import, also}]}` |
| `--search` | `{term, hits: [{doc, line, section, text}], total, files}` |
| Several names | `{answers: [...]}`, one element per name |

`--query <path>` prints one field of that result, raw: a string without quotes, `null` as an empty line, and an object as JSON. A list element is named by its index (`stopped.0.port`). A path the result cannot have (an unknown field at any level, a field of a plain value, a list element named by anything but its index) exits 2 before the command runs; an element past the end of a list prints an empty line.

```bash
API_URL=$(npm run -s deploy -- --query apiUrl)
npm run -s whoami -- --query stacks.production
```

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | The operation failed |
| 2 | Usage error: unknown command or option, missing argument, or a confirmation that a non-interactive run cannot give |
| 130 | Interrupted (Ctrl-C) |
| 143 | Stopped by a SIGTERM to the task runner, which ended the operation it ran (a deploy, a destroy, a sandbox deploy or destroy that core aborted) |

Errors print as `Error: <what failed>`, then where it failed and a `Try:` line with the next step. A command in the `Try:` line, or in the "re-run" guidance of a deploy, uses the app's package scripts so it can be run from the app directory. An unknown command or option suggests the closest name. Colour is used only on a terminal, and never when `NO_COLOR` is set.

`npm run destroy` prints the stack it deletes, then asks for confirmation in a terminal. Without a terminal (no TTY, `--no-input`, or `CI` set) it needs `--yes`, and exits 2 otherwise: `npm run destroy -- --yes`. `npm run sandbox:destroy` asks only in a terminal; `npm run sandbox:destroy -- --yes` skips the question.

### Per-app configuration

`npm run dev` and `npm run sandbox` read the local server settings from `package.json` under `"blocks"`:

```json
{
  "blocks": {
    "dev": { "port": 3000, "frontendPort": 3100 }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `port` | `3000` | The port you open in the browser. It serves the app and proxies the frontend dev server. |
| `frontendPort` | `3100` | The internal port the frontend dev server listens on. |
| `host` | `127.0.0.1` | The interface to bind. A `host` you set (or `--host`) is also exported to the dev server as `BLOCKS_DEV_HOST` (unless `BLOCKS_DEV_HOST` is already set, which then wins), which opts the local realtime WebSocket (`/realtime`) into that host's origins. |
| `frontend` | detected | `"frontend": false` runs the backend only even when a frontend dependency is installed, as `--no-frontend` does. It cannot be combined with `frontendCommand` or `frontendPort`. |
| `frontendCommand` | detected | The command that starts the frontend dev server. Set it only for a frontend that detection does not know. |

Flags override these settings: `npm run dev -- --port 4000` serves the app on http://localhost:4000.

Without `frontendCommand`, the frontend is detected from the app's dependencies and started on `frontendPort`. The first dependency in this order wins, so a Nuxt or Astro app that also lists `vite` runs its own dev server:

| Dependency | Command started |
|---|---|
| `next` | `npx next dev --webpack --hostname 127.0.0.1 --port <frontendPort>` |
| `nuxt` | `npx nuxt dev --host 127.0.0.1 --port <frontendPort> --strictPort` |
| `astro` | `npx astro dev --host 127.0.0.1 --port <frontendPort>` |
| `vite` | `npx vite --host 127.0.0.1 --port <frontendPort> --strictPort` (a SvelteKit app lists `vite`, and this starts it) |
| none of them | The backend only |

- Every detected command binds `127.0.0.1` explicitly, so a `HOST` variable in the environment or a `host` setting in `vite.config`, `nuxt.config` or `astro.config` does not expose the frontend dev server to the network. The dev server's own `host` is the only way to do that.
- Vite and Nuxt 4 exit when `frontendPort` is taken. Nuxt 3 and Astro move to another port, which they print, and the app answers 502 until you free `frontendPort` or choose another with `--frontend-port`.
- Do not start a frontend dev server next to `npm run dev` (for example `nuxt dev` or `astro dev` through `concurrently`): `npm run dev` starts one on `frontendPort`. Remove the app's own frontend process, or set `"frontend": false` to keep running the backend only.
- A `frontendCommand` must listen on `frontendPort` itself, so `--frontend-port` does not move it: `npm run dev` warns when the command does not contain the frontend port.

The lifecycle commands run the app's TypeScript with `tsx`:

- Keep `tsx` in your app's `devDependencies`, as the templates do. CDK synth runs the app's own `tsx`: through the `app` command in `cdk.json` (`npx tsx …` in the templates) for `npm run deploy` and `npm run destroy`, and through `npm exec tsx` for the sandbox commands.
- The task runner starts lifecycle operations and client generation (`npm run generate-client`, and the client step of `npm run deploy` and `npm run sandbox`) with the app's own `tsx` when it is installed, and otherwise with the one that `aws-cdk-blocks` depends on.
- `npm run dev` runs under `tsx watch`, which restarts it on a change. A failed reload waits for the next change.
- When the dev server crashes after it started (an uncaught exception outside any request, a `process.exit(1)` in the backend), `npm run dev` prints its exit code and starts it again after a backoff of 500 ms that doubles up to 5 s. After 5 restarts within 60 s, the next crash ends `npm run dev` with exit code 1.
- A failed first start, or a failed start of a restarted dev server, ends `npm run dev`.
- A dev server that a signal killed (`kill -9`, out of memory) is not restarted.

### Migrating an existing app

The `cdk-blocks` executable is not installed, and a global install or an `npx` invocation is not a substitute. For an app whose scripts call it or run generated `aws-blocks/scripts/*.ts` wrappers:

1. Update the app's `aws-cdk-blocks` dependency to a release that exports `/run`.
2. Install dependencies and commit that update.
3. From the app directory, invoke the installed runner directly once. This works before the app has a `migrate` script:

```bash
node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate --dry-run
# Review the plan; on a clean working tree, apply it:
node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate
```

4. Review `git diff` and the list of kept items. A customized wrapper is never deleted; it is reported with its script, which keeps running it. When `.cdk-blocks/config.json` is missing or has no `stackId`, the `deploy` and `destroy` scripts and their wrappers are kept.
5. Replace any remaining calls in CI, shell scripts and custom wrappers with the matching app script; for example, use `npm run sandbox:deploy`, not an executable on `PATH`.

Use `npm run migrate -- --dry-run` for subsequent checks once that script exists.

Migrate refuses, with exit 1 and a `Try:` hint, and writes nothing when:

- the working tree has uncommitted changes (a clean tree lets you review the result with `git diff` and undo it);
- git does not track the app, the app is outside git, or git is not installed.

`--force` skips these checks. `--dry-run` writes nothing and skips the checks, so run it first to see the plan.

| Exit code | Meaning |
|---|---|
| 0 | The app is fully migrated, or there is nothing to do |
| 1 | Kept items remain for you to finish by hand, or migrate refused and wrote nothing (with `--output json`, the `error` document tells the two apart). Kept items are a report, not a crash: everything else was migrated, and running it again is safe |
| 2 | Usage error |

Two commands behave differently after the migration: `npm run destroy` asks for confirmation (`npm run destroy -- --yes` in CI), and `npm run cleanup` stops only the dev servers this app recorded, instead of killing every process on ports 3000-3003.

Which scripts and wrappers migrate rewrites, keeps and deletes, how it finds what still uses a wrapper, finishing a kept `deploy`/`destroy`, a wrapper that cannot be deleted, every refusal, and the `--output json` shape are in [MIGRATING-FROM-SCRIPTS.md](./MIGRATING-FROM-SCRIPTS.md).

## Reference

- **Other docs of a block:** a doc path prints them where present: `DESIGN.md` (architecture & rationale) and `PRODUCTION.md` (production settings, scaling & cost), e.g. `npm run docs bb-file-bucket/PRODUCTION.md`.
- **What to import from where:** [IMPORTS.md](./IMPORTS.md) (`npm run docs IMPORTS.md`) lists every app-facing entry, where it runs, and every name it exports. Under the `browser` condition, the root entry exports client-safe values such as `isBlocksError`, `KVStoreErrors` and pure helpers, not Building Block classes. Use `/client`, `/ui` and `/theme` for the remaining browser APIs.
- **UI components** (`aws-cdk-blocks/ui`): `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, `broadcastAuthChange` — framework-agnostic, return DOM nodes. For custom auth forms, `submitAuthAction` submits an action and notifies every component and tab; `subscribeAuthState` / `getAuthStateSnapshot` expose the auth state as a store (React's `useSyncExternalStore`). See the `@aws-cdk-blocks/auth-common` README.
- **SSR** (`aws-cdk-blocks/server`): `withAuth` forwards browser cookies to API calls during server rendering. See the `@aws-cdk-blocks/core` README.
- **`curl`-level troubleshooting:** [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) (`npm run docs troubleshooting`).
