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

Each block is its own package; full per-block docs ship in this package under **`docs/<package-name>.md`**, and **`docs/index.md`** has a decision tree to help you pick.

| Building Block | Import | Use it for |
|---|---|---|
| `Scope` | `@aws-blocks/blocks` | Resource boundaries / grouping for your backend |
| `ApiNamespace` | `@aws-blocks/blocks` | Type-safe APIs wired to the frontend automatically |
| `KVStore` | `@aws-blocks/blocks` | Simple key-value get/put/delete (prefs, flags, caches) |
| `DistributedTable` | `@aws-blocks/blocks` | Structured data with indexes and queries — **default for most data** |
| `DistributedDatabase` | `@aws-blocks/blocks` | Serverless SQL (Aurora DSQL) — zero-ops, scales to zero |
| `Database` | `@aws-blocks/blocks` | Full PostgreSQL (Aurora) — FKs, RLS, triggers, or an existing DB |
| `AuthBasic` | `@aws-blocks/blocks` | Username/password auth for prototypes, internal tools, MVPs |
| `AuthCognito` | `@aws-blocks/blocks` | Cognito User Pools — MFA, groups, hosted identity |
| `AuthOIDC` | `@aws-blocks/blocks` | Sign-in gated by an external OIDC identity provider |
| `Realtime` | `@aws-blocks/blocks` | Push to browsers — chat, presence, live dashboards |
| `AsyncJob` | `@aws-blocks/blocks` | Fire-and-forget background work (emails, uploads, reports) |
| `CronJob` | `@aws-blocks/blocks` | Scheduled / recurring tasks |
| `FileBucket` | `@aws-blocks/blocks` | File storage — uploads, downloads, presigned URLs |
| `AppSetting` | `@aws-blocks/blocks` | A single config value or secret (flags, API keys) |
| `KnowledgeBase` | `@aws-blocks/blocks` | Semantic document retrieval / RAG (Bedrock + S3 Vectors) |
| `Agent` | `@aws-blocks/blocks` | AI agent — tool use, streaming, conversation persistence |
| `EmailClient` | `@aws-blocks/blocks` | Transactional email (SES) |
| `Logger` / `Metrics` / `Tracer` / `Dashboard` | `@aws-blocks/blocks` | Observability — structured logs, metrics, traces, CloudWatch dashboard |
| `Hosting` | `@aws-blocks/blocks` | Deploy a frontend (SPA / static / Next.js SSR) on CloudFront + S3 |

> **Not sure which data block?** Start with `DistributedTable` (DynamoDB). Reach for SQL only when you need joins across records, many-dimensional filtering, large transactions, or an existing Postgres database — `DistributedDatabase` for serverless Postgres, `Database` for full Aurora Postgres (FKs, RLS, triggers; carries idle cost / cold starts the other two don't). The full rationale is in `docs/index.md`.

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

- **Per-block documentation:** `docs/<package-name>.md` (e.g. `docs/bb-distributed-table.md`); `docs/index.md` for the catalog + decision tree.
- **UI components** (`@aws-blocks/blocks/ui`): `Authenticator`, `AuthenticatedContent`, `AccountMenuBar`, `onAuthChange`, `broadcastAuthChange` — framework-agnostic, return DOM nodes. See the `@aws-blocks/auth-common` README.
- **SSR** (`@aws-blocks/blocks/server`): `withAuth` forwards browser cookies to API calls during server rendering. See the `@aws-blocks/core` README.
- **Wire protocol & debugging:** the client is JSON-RPC 2.0 over a single endpoint — you should never call it directly. For `curl`-level troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
