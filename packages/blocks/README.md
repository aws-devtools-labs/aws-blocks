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

That's the whole model: **define blocks → export an API → import it on the frontend.** The transport (JSON-RPC over a single endpoint) is handled for you and is intentionally invisible.

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
  - Simple key → value (caches, flags, user prefs) → `KVStore` ([bb-kv-store](./docs/bb-kv-store/README.md))
  - Structured records with indexes and queries → `DistributedTable` ([bb-distributed-table](./docs/bb-distributed-table/README.md)) — **default for most data**
  - Relational / SQL (joins, transactions) → see [Choosing a data block](#choosing-a-data-block) below
  - Files, blobs, uploads, static assets → `FileBucket` ([bb-file-bucket](./docs/bb-file-bucket/README.md))
  - A single config value or secret → `AppSetting` ([bb-app-setting](./docs/bb-app-setting/README.md))
- **Authenticate users**
  - Username/password, prototypes/MVPs → `AuthBasic` ([bb-auth-basic](./docs/bb-auth-basic/README.md))
  - Cognito user pools, MFA, groups → `AuthCognito` ([bb-auth-cognito](./docs/bb-auth-cognito/README.md))
  - External identity provider (OIDC) → `AuthOIDC` ([bb-auth-oidc](./docs/bb-auth-oidc/README.md))
- **Run work outside the request/response**
  - Fire-and-forget background jobs → `AsyncJob` ([bb-async-job](./docs/bb-async-job/README.md))
  - Scheduled / recurring tasks → `CronJob` ([bb-cron-job](./docs/bb-cron-job/README.md))
- **Push live updates to browsers** (chat, presence, dashboards) → `Realtime` ([bb-realtime](./docs/bb-realtime/README.md))
- **Build AI features**
  - Agent with tool use + conversation → `Agent` ([bb-agent](./docs/bb-agent/README.md))
  - Semantic document retrieval (RAG) → `KnowledgeBase` ([bb-knowledge-base](./docs/bb-knowledge-base/README.md))
- **Send transactional email** → `EmailClient` ([bb-email-client](./docs/bb-email-client/README.md))
- **Observe and operate**
  - Structured logs → `Logger` ([bb-logger](./docs/bb-logger/README.md))
  - Custom metrics → `Metrics` ([bb-metrics](./docs/bb-metrics/README.md))
  - Distributed traces → `Tracer` ([bb-tracer](./docs/bb-tracer/README.md))
  - Auto CloudWatch dashboard → `Dashboard` ([bb-dashboard](./docs/bb-dashboard/README.md))

### Choosing a data block

Default to `DistributedTable` for your data models unless your domain specifically requires SQL engine capabilities.

Reach for one of the SQL blocks when you need to filter or join results across more than one related record, filter models on many dimensions with no preset hierarchy, store large objects, require transactions, or otherwise need the flexibility or familiarity of SQL that NoSQL does not offer.

If you need SQL, prefer `DistributedDatabase` for basic Postgres-compatible querying. Use `Database` specifically when you need a full (more expensive) Postgres implementation where the engine itself provides and enforces foreign keys, row level security, triggers, views, large transactions (more than 3,000 rows), or integration with an existing Postgres database. Note it carries an idle cost at minimum 0.5 ACU, or a cold start when scaling from zero, unlike the other two blocks.

### Catalog

One folder per Building Block under `docs/<block>/`: start with its `README.md`, then read `API.md` for exact signatures and `DESIGN.md` for architecture & rationale. The catalog below is generated — run `npm run sync-docs` after adding or removing a block.

<!-- BEGIN:block-catalog -->
| Block | What it does | Keywords |
|-------|--------------|----------|
| [auth-common](./docs/auth-common/README.md) | Shared interfaces and UI components for all AWS Blocks auth Building Blocks. | — |
| [bb-agent](./docs/bb-agent/README.md) | AI agent with streaming, tool calling, and conversation persistence. | — |
| [bb-app-setting](./docs/bb-app-setting/README.md) | A single application configuration value backed by SSM Parameter Store. | — |
| [bb-async-job](./docs/bb-async-job/README.md) | Background job processing backed by SQS and Lambda. | queue, job, background, async, worker, submit, batch, retry, SQS |
| [bb-auth-basic](./docs/bb-auth-basic/README.md) | Simple username/password authentication with JWT sessions, password policy, and optional code-confirmed signup and password reset. | — |
| [bb-auth-cognito](./docs/bb-auth-cognito/README.md) | Authentication backed by Amazon Cognito User Pools. | — |
| [bb-auth-oidc](./docs/bb-auth-oidc/README.md) | OIDC sign-in gate for AWS Blocks applications. | — |
| [bb-cron-job](./docs/bb-cron-job/README.md) | Scheduled task execution backed by EventBridge Scheduler and Lambda. | cron, schedule, timer, periodic, recurring, rate, EventBridge, background, interval |
| [bb-dashboard](./docs/bb-dashboard/README.md) | Auto-generated CloudWatch Dashboard for application observability. | — |
| [bb-data](./docs/bb-data/README.md) | Full PostgreSQL database — provisions Aurora Serverless v2 by default, or connects to an existing PostgreSQL database (Supabase, Neon, etc.) via `fromExisting()`. | — |
| [bb-distributed-data](./docs/bb-distributed-data/README.md) | Serverless SQL database backed by Amazon Aurora DSQL. | — |
| [bb-distributed-table](./docs/bb-distributed-table/README.md) | Structured data storage backed by DynamoDB with secondary indexes and rich query capabilities. | — |
| [bb-email-client](./docs/bb-email-client/README.md) | Transactional email sending via Amazon SES. | — |
| [bb-file-bucket](./docs/bb-file-bucket/README.md) | File storage backed by Amazon S3. | — |
| [bb-knowledge-base](./docs/bb-knowledge-base/README.md) | Semantic document retrieval backed by Amazon Bedrock Knowledge Bases. | — |
| [bb-kv-store](./docs/bb-kv-store/README.md) | Simple key-value storage backed by DynamoDB. | — |
| [bb-logger](./docs/bb-logger/README.md) | Structured logging with consistent JSON format, log levels, and contextual metadata. | — |
| [bb-metrics](./docs/bb-metrics/README.md) | Custom application metrics backed by Amazon CloudWatch (via Embedded Metric Format). | — |
| [bb-realtime](./docs/bb-realtime/README.md) | Real-time pub/sub messaging backed by API Gateway WebSocket + DynamoDB. | — |
| [bb-tracer](./docs/bb-tracer/README.md) | Distributed tracing backed by AWS X-Ray. | — |
| [core](./docs/core/README.md) | Core primitives for building full-stack applications with the AWS Blocks. | — |
| [hosting](./docs/hosting/README.md) | Low-level CDK L3 constructs for deploying web applications on AWS | — |
| [pipeline](./docs/pipeline/README.md) | CDK Pipelines-based CI/CD construct for AWS Blocks applications. | — |
<!-- END:block-catalog -->

## Local development and deploying

| | `npm run dev` | `npm run sandbox` |
|---|---|---|
| Blocks run as | in-memory mocks | real AWS services |
| AWS account | not needed | required |
| Data | persists to `.bb-data/` (delete to reset) | lives in AWS |
| Use for | rapid iteration, tests | pre-production validation against real services |

`npm run deploy` does a full production deploy; `npm run sandbox:destroy` tears the sandbox down. The same backend code runs in all three — blocks switch implementations automatically.

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
- **Curling REST-style paths** — there is no `GET /api/getData`. All calls are JSON-RPC to a single `POST /aws-blocks/api`; use the typed import instead.

## Reference

- **Per-block documentation:** `docs/<block>/README.md` (overview), `docs/<block>/API.md` (full API reference), `docs/<block>/DESIGN.md` (architecture & rationale) — e.g. `docs/bb-distributed-table/README.md`. The catalog + decision tree live in `docs/README.md`.
- **UI components** (`@aws-blocks/blocks/ui`): `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, `broadcastAuthChange` — framework-agnostic, return DOM nodes. See the `@aws-blocks/auth-common` README.
- **SSR** (`@aws-blocks/blocks/server`): `withAuth` forwards browser cookies to API calls during server rendering. See the `@aws-blocks/core` README.
- **Wire protocol & debugging:** the client is JSON-RPC 2.0 over a single endpoint — you should never call it directly. For `curl`-level troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
