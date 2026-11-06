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
| bb-cron-job | Scheduled task execution backed by EventBridge Scheduler and Lambda, or a container compute for long-running jobs. | cron, schedule, timer, periodic, recurring, rate, EventBridge, background, interval |
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
| On a file change | the server reloads | a code-only change is hotswapped into the deployed functions in seconds; a change that needs new or changed infrastructure (for example adding a `Database` or `Realtime`) runs a full deploy of the stack, which takes minutes |

> **Deploying needs AWS credentials.** `npm run dev` is fully local (no creds). `npm run sandbox` and `npm run deploy` provision real AWS resources, so configure credentials first — e.g. `aws login` (AWS CLI 2.32.0 or later), `aws configure sso` + `aws sso login`, or `aws configure` (verify with `aws sts get-caller-identity`). If the credentials are missing or expired, both commands stop before synthesizing and print the sign-in or refresh command for the profile they use, with that profile and the deployment Region. When the fix is `aws login` and the profile has no Region or another one, they first print `aws configure set region <region> --profile <name>`, so that you sign in to the Region you deploy to; after a later Region change, sign in again. When `AWS_REGION` or `AWS_DEFAULT_REGION` names another Region, the printed `aws login` includes `--region <region>`. If AWS denies the check, for example because an AWS Organizations policy explicitly denies it, they warn and continue, and the deploy reports any error. Use **least-privilege** credentials scoped to the services your cdk-blocks deploy — not broad `Administrator` access.

Before they deploy, `npm run sandbox` and `npm run deploy` print the deployment target: the credentials that CDK deploys with (an AWS profile, environment access keys, or container or web identity credentials) and the configured Region. As in CDK, environment access keys are used before `AWS_PROFILE` unless `cdk.json` sets a profile. With valid credentials they also show the account name and the AWS account plan (Free or Paid) when those credentials allow `account:GetAccountInformation` and `freetier:GetAccountPlanState`. Otherwise they show "not available" and continue; these reads never stop a deploy. When you sign in with the AWS-managed role of the new AWS sign-up experience (a role at the path `/managed/` that `account-access.amazonaws.com` can assume, checked with `iam:GetRole`), the output also links to `https://settings.aws.com/billing` for spend limits. In AWS Settings, verify that the project you intend to manage matches the CLI deployment target before viewing or changing its spend limit. If you sign in with `aws login`, set the profile Region to your project's Region before you sign in (`aws configure set region <region> --profile <name>`), and run `aws login` again if you change it later. `npm run sandbox:destroy` and `npm run destroy` print only the deployment target.

With verified credentials, `npm run sandbox` (including `npm run sandbox:deploy`) and `npm run deploy` also check that CDK has been bootstrapped in that account and Region: they read the SSM parameter `/cdk-bootstrap/<qualifier>/version`, where the qualifier is `@aws-cdk/core:bootstrapQualifier` from the `cdk.json` context, or CDK's default. When the parameter does not exist, they stop before synthesizing and print the command that bootstraps this account and Region, `npx cdk bootstrap aws://<account-id>/<region> --app=`. Run it from the project directory; `--app=` keeps CDK from synthesizing the app first. Bootstrapping is needed once per account and Region, and it creates the `CDKToolkit` CloudFormation stack, including IAM roles that CDK deploys with, so the commands never bootstrap for you. Any other result of the read, such as a denied read or a timeout, does not stop the deploy.

When the CDK output shows that AWS denied a request of the deploy itself, for example a CloudFormation resource that fails with `is not authorized to perform`, `npm run deploy` and `npm run sandbox` (including each deployment of its watch mode) print `⚠️  AWS denied a request during <command>`, naming the command that ran (for example `npx --no -- cdk-blocks deploy`, which `npm run deploy` runs), as soon as the failure is reported, without waiting for the rollback to finish, and once per deployment. The notice says whether an AWS Organizations policy (a service control policy or a resource control policy) explicitly denied the request, which signing in again or adding IAM permissions does not change. It adds none of the error's account IDs, ARNs or policy IDs, and the command fails as before. The CDK output keeps the details: with `--verbose` it is shown as it arrives; otherwise the `cdk-blocks` CLI shows it condensed (nothing with `--quiet`) and prints all of it once the deploy has failed, after the notice. After such a failure, `npm run sandbox` prints this instead of its Express Mode recovery note: after the first deploy of a sandbox, the stack left in a failed state holds no data and `npm run sandbox:destroy` removes it; a sandbox that existed before must not be destroyed, which deletes its data, so run `npm run sandbox` again once the cause is resolved. The sandbox deploy's CDK output has one line per CloudFormation event, as `npm run deploy` does; with `CI` set and `--verbose`, the CDK CLI prints those events to the inherited stdout and the sandbox explains a denial from the error that the CDK CLI prints when the deploy fails. When credentials expire or are rejected during `npm run sandbox`, including while its watch mode runs, it prints the sign-in guidance of the credential check before the deploy, for the profile or access keys that it deploys with, once per deployment, and says whether saving a file (IAM Identity Center and `aws login` profiles) or restarting `npm run sandbox` (access keys in the environment or a profile) picks up the new credentials.

`npm run deploy` does a full production deploy; `npm run sandbox:deploy` deploys the sandbox once and exits (no watch, for scripts and CI); `npm run sandbox:destroy` tears the sandbox down. The same backend code runs in all three — blocks switch implementations automatically.

Importing `@aws-blocks/blocks` through its default (Node) entry declares the default compute (`LambdaCompute`) so the CLI reports it in telemetry. It is folded in only when telemetry reads the registry, after the blocks the app constructed, and an app-constructed `LambdaCompute` takes precedence. The `cdk` and `browser` entries do not declare it.

`npm run deploy` streams CloudFormation events as they happen, so `npm run deploy 2>&1 | tee deploy.log` shows live progress instead of going silent for minutes. Through the `cdk-blocks` CLI (which the npm scripts call), the events and other progress go to **stderr**, and stdout keeps the results: the deployment target line, the `BLOCKS_DEPLOYED` line and the final URLs. A deploy failure keeps its reason on **stderr** (that stays the place to grep for why a deploy failed). On POSIX the deploy also survives a stray reap: a single `SIGTERM`, or any `SIGHUP` — a closed terminal, a backgrounded `npm run deploy &` — logs a line and keeps streaming rather than abandoning a stack update CloudFormation is still applying. Press Ctrl-C, or send `SIGTERM` twice, to stop it. That signal resilience is POSIX-only: Windows has no process groups and no OS-delivered `SIGTERM`/`SIGHUP`, so there a kill on the process tree still ends the deploy.

## CLI

`@aws-blocks/blocks` ships the `cdk-blocks` command for development tasks; its version is the installed `@aws-blocks/blocks` version. A generated app's npm scripts call it (`npm run deploy` runs `cdk-blocks deploy`), and `npm run dev -- --port 4000` passes flags through. To run it directly, use `npx --no -- cdk-blocks <command>`. It runs from anywhere inside an app: it finds the project root by walking up to the `package.json` that has an `aws-blocks/` directory, or uses `-C <dir>`. `npx --no -- cdk-blocks -h` lists the commands, and `npx --no -- cdk-blocks <command> -h` shows a command's options.

```bash
npx --no -- cdk-blocks --help            # grouped command list
npx --no -- cdk-blocks help deploy       # help for one command; same as `npx --no -- cdk-blocks deploy --help`
npx --no -- cdk-blocks --version
```

> Inside an app, run the command as `npx --no -- cdk-blocks` (the `--` stops npm from reading `--help` or `--version` as its own options) or through the app's npm scripts, never a bare `npx cdk-blocks`: `--no` uses the CLI installed with `@aws-blocks/blocks` and never downloads a package, while a bare `npx` would install whatever is published under that name, without asking in CI.
>
> Without installing, name the package: `npx -p @aws-blocks/blocks cdk-blocks <command>`. A plain `npx @aws-blocks/blocks <command>` fails with `could not determine executable to run`, because no command of the package has its unscoped name. A global install, `npm i -g @aws-blocks/blocks`, puts `cdk-blocks` on `PATH`.

`cdk-blocks [global options] <command> [<subcommand>] [arguments] [-- passthrough]`

| Group | Command | Does |
|---|---|---|
| Develop | `cdk-blocks dev [--port N] [--no-frontend]` | Run the app locally, with reload; no AWS |
| | `cdk-blocks dev stop [--port N] [--all]` | Stop the local dev server this app started |
| | `cdk-blocks sandbox` | Deploy your personal sandbox, watch for changes, and run the local server against it |
| | `cdk-blocks sandbox deploy` | Deploy the sandbox once and exit (CI) |
| | `cdk-blocks sandbox preview` | Deploy the sandbox with a hosted preview of the frontend once and exit; prints the preview URL |
| | `cdk-blocks sandbox destroy [--yes]` | Delete your sandbox stack; never production |
| | `cdk-blocks sandbox console` | Open the AWS console for the sandbox stack |
| Deploy | `cdk-blocks deploy [--wait-live[=SECONDS]]` | Deploy the production stack; the target is printed first |
| | `cdk-blocks destroy [--yes]` | Delete the production stack, after a confirmation |
| | `cdk-blocks whoami` | Show the AWS identity and Region that `deploy` uses (with `.env.production` applied), and the stacks that `sandbox` and `deploy` would affect |
| Configure | `cdk-blocks secret set KEY` / `list` / `remove KEY` | Manage secrets; a value is never accepted on the command line |
| | `cdk-blocks config set KEY VALUE` / `list` / `remove KEY` | Manage non-secret config |
| | `cdk-blocks telemetry [status\|enable\|disable] [--global]` | Show or change telemetry consent |
| Generate | `cdk-blocks generate client [foundation] [output]` | Generate the typed client (`aws-blocks/client.js`) |
| | `cdk-blocks generate spec [backend] [output]` | Generate the OpenRPC spec |
| | `cdk-blocks generate types [--check]` | Generate secret/config key types; `--check` exits 1 when stale |
| Data and blocks | `cdk-blocks db <migrate\|status\|generate-types\|pull> [args...]` | Data block operations, forwarded unchanged to the `bb-data` CLI |
| Project | `cdk-blocks vendorize <package> [--force]` | Copy a Building Block into the app for customization |
| | `cdk-blocks migrate [--dry-run] [--force]` | Move an app from `aws-blocks/scripts/*.ts` wrappers to `cdk-blocks` commands |
| | `cdk-blocks help [command...]` | Help |

The npm-script spellings also work as hidden aliases: `dev:stop`, `sandbox:deploy`, `sandbox:preview`, `sandbox:destroy`, `sandbox:console`, `console`, `typegen`, `generate-client`, `spec`, `cleanup` (`dev stop --all`), `sandbox --deploy-only` (`sandbox deploy`), and `sandbox --preview` (`sandbox preview`). Global options can go before the command, between its words (`cdk-blocks generate --debug client`) or after it. `db`, `secret`, `config` and `vendorize` forward the tokens after their name to their tool unchanged, except the global options before a `--`, which apply to the run: `cdk-blocks secret list --profile prod` lists the secrets of that profile's account, and `cdk-blocks config list --output json` exits 2 because `config` has no JSON output. After `--`, every token is the tool's: `cdk-blocks config set GREETING -- -hello-`. A relative path given to `db` or `generate client|spec|types` (including `--out` and `--include`) is resolved from the directory you run the command in, as it was with the tools themselves. The exception is `-h`/`--help`: anywhere after one of these commands it shows help and never runs the tool with your arguments. For a verb of the tool (`cdk-blocks db pull ./out --help`, `cdk-blocks help secret remove KEY`), only `<verb> --help` reaches the tool, which prints that verb's usage.

The CLI collects usage data to improve AWS Blocks and prints a notice the first time it does. An event can include random installation and project IDs, and an event ID and timestamp; the command, its outcome, duration and error category (never the error message); your OS, Node.js version and package manager user agent; whether it ran in CI or under a coding agent; the AWS Blocks and CDK versions, the framework, and the template name and version; and the names and versions of the official Building Blocks the app uses, how many Building Blocks it uses, and how many of them are custom (custom Building Block names are never sent). Events never include names, email addresses, AWS account IDs, ARNs, file paths, file contents or source code. As with any HTTPS request, the collection endpoint also receives your IP address. To opt out everywhere, set `AWS_BLOCKS_DISABLE_TELEMETRY` to `1`, `true` or `yes`, or run `npx --no -- cdk-blocks telemetry disable --global` or `npx --no -- blocks-telemetry --disable --global` inside an AWS Blocks app. Without `--global`, these commands opt out the current app only. Pass `--telemetry-file <path>` to see the exact events a run sends.

Run `npm run typegen` once and commit `.blocks/hosting-values.d.ts` before gating CI on `npm run typegen -- --check`; until then the check exits 1.

`secret` and `config` take `--stage <name>` with any name; there is no fixed list. A value set with `--stage <name>` is read only by an app whose Hosting `secretStore` (or `configStore`) sets `stage: '<name>'`. Without `--stage`, the value is shared, and every stage falls back to it.

Global options: `-h`/`--help`, `--version`, `-q`/`--quiet`, `-v`/`--verbose`, `--debug`, `--output text|json`, `--query <path>`, `-y`/`--yes`, `--no-input`, `--profile <name>` (sets `AWS_PROFILE`), `--region <region>` (sets `AWS_REGION`), `-C`/`--cwd <dir>` and `--telemetry-file <path>`. The log level is passed to child processes as `BLOCKS_LOG_LEVEL=quiet|normal|verbose|debug`. `--telemetry-file` (also `--telemetry-file=<path>`) is passed to the lifecycle runners, which also write the run's telemetry events to that file: `npm run dev -- --telemetry-file=/tmp/events.json`. A relative path is resolved from the directory you run the command in.

### Output and exit codes

Results go to stdout; progress, warnings and errors go to stderr. In text mode the CLI runs core with `BLOCKS_LOG_STREAM=stderr`: core's progress lines, the CDK milestones, raw CDK output (`--verbose`/`--debug`) and the streamed CloudFormation events go to stderr, while the result lines — `🎯 Deployment target: …`, `BLOCKS_DEPLOYED …` and the final URLs — stay on stdout. Without `BLOCKS_LOG_STREAM` (core's scripts called directly) the streams are as before. With `--output json`, stdout carries exactly one JSON document and all output of CDK and other child tools moves to stderr; after a failed or interrupted deploy no result is printed. `cdk-blocks deploy` and `cdk-blocks sandbox deploy` print `{apiUrl, url, stack, account, region}`, where the account and Region are the ones the deploy itself used (it loads `.env.production` or `.env.local`); `cdk-blocks deploy` adds `live`: `true` when `--wait-live` confirmed the new build, `false` when its wait failed (the deploy succeeded, the result is printed, and the command exits 1), `null` otherwise; `cdk-blocks whoami` prints `{account, arn, credentials, region, projectRoot, stacks: {sandbox, production}}`; `cdk-blocks dev stop` prints `{stopped: [{port, stopped, alreadyStopped, portFree, via}, …]}`. Arguments after `--` are an error (exit 2) except for `db`, `secret`, `config` and `vendorize`, which forward them.

`--query <path>` prints one field of that result, raw: a string without quotes, `null` as an empty line, and an object as JSON. A list element is named by its index (`stopped.0.port`). A path the result cannot have (an unknown field at any level, a field of a plain value, a list element named by anything but its index) exits 2 before the command runs; an element past the end of a list prints an empty line.

```bash
API_URL=$(npx --no -- cdk-blocks deploy --query apiUrl)
npx --no -- cdk-blocks whoami --query stacks.production
```

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | The operation failed |
| 2 | Usage error: unknown command or option, missing argument, or a confirmation that a non-interactive run cannot give |
| 130 | Interrupted (Ctrl-C) |
| 143 | Stopped by a SIGTERM to `cdk-blocks`, which ended the operation it ran (a deploy, a destroy, a sandbox deploy or destroy that core aborted) |

Errors print as `Error: <what failed>`, then where it failed and a `Try:` line with the next step. A command in the `Try:` line, or in the "re-run" guidance of a deploy, is written `npx --no -- cdk-blocks …`, so it runs as printed in the app's shell, where `cdk-blocks` is not on `PATH`. An unknown command or option suggests the closest name. Colour is used only on a terminal, and never when `NO_COLOR` is set.

`cdk-blocks destroy` prints the stack it deletes, then asks for confirmation in a terminal. Without a terminal (no TTY, `--no-input`, or `CI` set) it needs `--yes`, and exits 2 otherwise: `npx --no -- cdk-blocks destroy --yes`.

### Per-app configuration

`cdk-blocks dev` and `cdk-blocks sandbox` read the local server settings from `package.json` under `"blocks"`:

```json
{
  "blocks": {
    "dev": { "port": 3000, "frontendPort": 3100 }
  }
}
```

`port` is the port you open in the browser; it serves the app and proxies the frontend dev server, which listens on the internal `frontendPort` (default `3100`). `host` sets the interface to bind (default `127.0.0.1`); a `host` you set (or `--host`) is also exported to the dev server as `BLOCKS_DEV_HOST` (unless `BLOCKS_DEV_HOST` is already set, which then wins), which opts the local realtime WebSocket (`/realtime`) into that host's origins. Without `frontendCommand`, the frontend is detected from the app's dependencies and started on `frontendPort`: `next` runs `npx next dev --webpack --hostname 127.0.0.1 --port <frontendPort>`, `vite` runs `npx vite --port <frontendPort> --strictPort`, and neither runs the backend only. `"frontend": false` runs the backend only even when `next` or `vite` is installed, as `--no-frontend` does; it cannot be combined with `frontendCommand` or `frontendPort`. Set `frontendCommand` only for a frontend that detection does not know. It must listen on `frontendPort` itself, so `--frontend-port` does not move it: `cdk-blocks dev` warns when the command does not contain the frontend port. Flags override both: `npm run dev -- --port 4000` serves the app on http://localhost:4000.

The lifecycle commands run the app's TypeScript with `tsx`. The CLI runs its runners and client generation (`cdk-blocks generate client`, and the client step of `cdk-blocks deploy` and `cdk-blocks sandbox`) with the app's own `tsx` when it is installed, and otherwise with the one that `@aws-blocks/blocks` depends on. `cdk-blocks dev` runs under `tsx watch`, which restarts it on a change; the other runners run as `node --import` with the `tsx` loader, with no `tsx` process in between, so a closed terminal does not end `cdk-blocks deploy` before the deploy it runs. CDK synth is different: CDK runs the app's own `tsx`, through the `app` command in `cdk.json` (`npx tsx …` in the templates) for `cdk-blocks deploy` and `cdk-blocks destroy`, and through `npm exec tsx` for the sandbox commands. So keep `tsx` in your app's `devDependencies`, as the templates do.

### Migrating an app from `aws-blocks/scripts`

Apps that create-blocks-app scaffolded before the CLI ran lifecycle wrappers in `aws-blocks/scripts/*.ts` (`"deploy": "tsx aws-blocks/scripts/deploy.ts"`). New apps call the CLI from the same npm scripts instead (`"deploy": "cdk-blocks deploy"`). `cdk-blocks migrate` moves an existing app over:

```bash
npx --no -- cdk-blocks migrate --dry-run   # print the plan; write nothing
npx --no -- cdk-blocks migrate             # rewrite the scripts and delete the generated wrappers
```

- A wrapper (`server.ts`, `stop.ts`, `sandbox.ts`, `sandbox-destroy.ts`, `console.ts`, `cleanup.ts`, `deploy.ts`, `destroy.ts`, `secret.ts`, `typegen.ts`, and the Amplify overlay's `server.ts` and `stop.ts`) counts as generated when it matches, ignoring whitespace, a version that a public create-blocks-app release (0.1.0 to 0.4.0) shipped. Only those releases are recognised: any other content, whether you changed the file or it comes from a release migrate does not know, is reported as an "unrecognised version" and kept, with the script that runs it.
- A script is rewritten only when its value is exactly the generated command and the wrapper it runs is generated: `tsx watch aws-blocks/scripts/server.ts` becomes `cdk-blocks dev`, `tsx aws-blocks/scripts/sandbox.ts --deploy-only` becomes `cdk-blocks sandbox deploy`, `tsx aws-blocks/scripts/sandbox.ts --preview` becomes `cdk-blocks sandbox preview`, `tsx -C cdk aws-blocks/scripts/sandbox-destroy.ts` becomes `cdk-blocks sandbox destroy`, and so on. Every other script is left alone. Some generated scripts are kept and reported too:
  - When `server.ts` is customized, the `sandbox`, `sandbox:deploy` and `sandbox:preview` scripts are kept, because a generated `sandbox.ts` starts `server.ts` as the sandbox's dev server and `cdk-blocks sandbox` would bypass the custom server. In the Amplify overlay, `blocks:stop` and `stop.ts` are kept as well: the overlay's `stop.ts` stops the port of its `server.ts`, but `cdk-blocks dev stop` stops the `blocks.dev` port, which migrate takes only from a generated `server.ts`.
  - When `.blocks/config.json` is missing or has no `stackId`, as in apps scaffolded before create-blocks-app wrote that file, the `deploy` and `destroy` scripts and their wrappers are kept. `cdk-blocks deploy` and `cdk-blocks destroy` name the production stack `<stackId>-prod` and stop without it. To finish, create `.blocks/config.json` with `{"stackId": "<id>"}`, where `<id>-prod` must equal the name of the production stack that your `aws-blocks/index.cdk.ts` defines (an app whose `index.cdk.ts` hard-codes `'my-blocks-stack-prod'` uses `{"stackId": "my-blocks-stack"}`), commit it, and run `cdk-blocks migrate` again. A `.blocks/config.json` that is not valid JSON keeps them too, and the report quotes the parse error so you can fix the file.
- The `port`, `frontendCommand`, `frontendPort` and `frontend` (`false` for a backend-only `server.ts`) of a generated `server.ts` move to `package.json#blocks.dev`, unless `blocks.dev` already exists. `frontendCommand` is written only when it differs from the command `cdk-blocks dev` detects from the app's `vite` or `next` dependency on that `frontendPort`, so a migrated default app gets `{"frontendPort": 3100}`, as new apps do, and `--frontend-port` keeps working.
- A generated wrapper is deleted once no script and no file in the app directory other than a Markdown doc uses it, by its project path (`aws-blocks/scripts/deploy.ts`) or by a relative path such as `import '../server.js'`. In a git repository, migrate reads the files that git lists for the app directory: tracked files and untracked files that are not gitignored, in any directory, so gitignored build output (`build-temp`, `dist`) and logs do not count, and a tracked `tools/build/release.sh` does. It also reads the files of a submodule or of an untracked git repository inside the app. Outside git, or when git does not list the app's `package.json` (a parent repository ignores the app's directory), it reads the files under the app directory, dot directories such as `.github` and `.vscode` included, and skips `node_modules`, `.git`, build output and tool caches (`dist`, `build`, `build-temp`, `cdk.out`, `.blocks-sandbox`, `.next` and the like). Either way shell scripts, Dockerfiles and CI workflows count, and Markdown docs and editor rules (`*.md`, `*.mdx`, `*.mdc`), binary files, files over 1 MiB and symbolic links do not. The fields of the app's `package.json` other than `scripts` count as well, such as a `lint-staged`, `simple-git-hooks` or `nodemonConfig` block that runs a wrapper; the wrapper is kept and reported as used by `package.json#<field>`. Shell scripts, Dockerfiles, CI files and `package.json` scripts and fields can run from another working directory (`working-directory: aws-blocks`, `cd aws-blocks/scripts && npx tsx typegen.ts`), so in them a bare `scripts/deploy.ts` or `deploy.ts` counts too. When the app is a subdirectory of its git repository (a monorepo), migrate also reads every `package.json` and every CI, shell, Make and Docker file that git tracks in the repository outside the app (`.github/workflows/*`, `scripts/deploy-web.sh`, `ci/Makefile`, a sibling workspace's `package.json`; not under `node_modules`, and not files over 1 MiB). When the app is in a git submodule, it reads those files of the superproject too. In those files a path counts only when it names this app: `apps/web/aws-blocks/scripts/deploy.ts`, a path relative to the file, or a bare `aws-blocks/scripts/deploy.ts` or `deploy.ts` in a file that changes into the app (`working-directory: apps/web`, `cd apps/web`, `cd "$(git rev-parse --show-toplevel)/apps/web"`, or `cd "$(dirname "$0")/../apps/web"` from the script's own directory), so another app's workflow does not keep this app's wrappers. It reads nothing else outside the app directory. A wrapper that a kept wrapper starts is kept too: a `sandbox.ts` that stays keeps its `server.ts`. A customized wrapper is never deleted; it is reported with its script, which keeps running it. The Amplify overlay's `generate-client.ts` and files migrate does not know are left alone.
- In a git repository it refuses a working tree with uncommitted changes (exit 1, with a `Try:` hint), so you can review the result with `git diff` and undo it. It also refuses an app that git does not track, such as one in a directory that a parent repository ignores, because git could not undo the changes, and a repository that git fails to read (for example "detected dubious ownership" in a checkout another user owns), quoting git's error. For the same reason it refuses an app outside git, or where git is not installed. `--force` skips these checks; outside git, or where git does not track the app or fails to read it, migrate then reads the files under the app directory. `--dry-run` writes nothing and skips the checks, so run it first to see the plan. If `package.json` changes while migrate scans the app, it stops with "package.json changed while cdk-blocks migrate ran; nothing was written", even with `--force`.
- `--output json` prints `{changed, removed, kept: [{file, reason}], scriptsRewritten: {name: {from, to}}, devConfig}`. `devConfig` is the `blocks.dev` config (`{port?, frontendCommand?, frontendPort?, frontend?: false}`) that migrate added to `package.json`, or with `--dry-run` would add, and `null` when it adds none. When migrate refuses (an app outside git, an uncommitted change, an app git does not track, a git failure, a `package.json` that changed during the run), it writes nothing and prints `{"error": {"message", "hint"}}` instead, as well as the error on stderr. With `--query`, a refusal prints only the error, on stderr, and nothing on stdout.
- Exit codes: 0 when the app is fully migrated or there is nothing to do; 1 when kept items remain for you to finish by hand, or when migrate refused and wrote nothing (with `--output json`, the `error` document tells the two apart); 2 for a usage error. Kept items are a report, not a crash: everything else was migrated, and running it again is safe.

Two commands behave differently after the migration: `npm run destroy` asks for confirmation (`npm run destroy -- --yes` in CI), and `npm run cleanup` stops only the dev servers this app recorded, instead of killing every process on ports 3000-3003.

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
- **Test locally first** — mocks implement the same API as the real service, but not every AWS behavior (limits, TTL expiry, IAM, partial failures); check the mock-vs-AWS differences in a block's `DESIGN.md` where it has one. Deploy to a sandbox once it's green.

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
