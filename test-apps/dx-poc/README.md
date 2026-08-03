# DX POC — the Next-native programming model

A proof-of-concept for using blocks as plain app-code modules on Next.js. Three things it
demonstrates, each covered by tests here:

1. **A Server Component queries real Postgres in process** — no wrapper method, no RPC hop.
2. **Types come from the migrations** with no command to run.
3. **A browser reads and writes through one endpoint**, gated by Row Level Security.

Local dev only; nothing here is deployed.

```bash
npm run dev              # http://localhost:3310
npm run test:e2e:local   # typecheck + 18 assertions
```

## What's different from the shipped templates

| | Templates today | Here |
|---|---|---|
| Backend location | `aws-blocks/` npm sub-package | `lib/backend.ts`, a plain file |
| Generated client | `client.js` checked in | none |
| Server → data | HTTP JSON-RPC to a second Lambda | direct, in process |
| Adding a query | migration + block + `ApiNamespace` wrapper + page | migration + use it where you need it |
| Blocks wiring | `resolve.conditions` / export map | `withBlocks()` |

## Layout

```
lib/backend.ts               # blocks constructed here — `server-only`
lib/notes.ts                 # queries — `server-only`
lib/schema/                  # GENERATED from ./migrations — committed, never hand-edited
lib/data-client.ts           # browser data client — deliberately NOT server-only
lib/dev-auth.ts              # NOT authentication; a stand-in, see below
migrations/001_create_notes.sql
migrations/002_notes_rls.sql # roles, ownership, RLS policy
src/app/page.tsx             # Server Component: reads the DB directly
src/app/actions.ts           # Server Actions: the client→server boundary
src/app/api/data/route.ts    # ONE endpoint serving every table
src/app/note-form.tsx        # Client Component: imports actions, never the backend
next.config.ts               # withBlocks()
```

## Browser queries with no endpoint per query

`src/app/api/data/route.ts` is the entire browser data surface. The browser posts a query
*description*; the server validates it against the generated schema and an opt-in table
list, then runs it under RLS with the caller's claims.

```ts
const notes = await data.from('notes').select('id', 'text').eq('done', false).limit(20);
```

`migrations/002_notes_rls.sql` defaults `owner` from `request.jwt.claims`, which makes
introspection classify it as server-managed — so a client cannot create a row for someone
else even before the policy's `WITH CHECK` is consulted.

`test/data-api.test.js` proves over real HTTP that an anonymous caller gets 401, a
non-exposed table 403, malformed queries 400, and that one user can neither read, delete,
nor forge ownership of another's row.

> **`lib/dev-auth.ts` is not authentication.** It trusts a request header, so anyone can
> claim to be anyone. It exists so the POC can exercise the data API's authorization
> contract without wiring a full auth provider, and it throws when `NODE_ENV=production`
> so it can't be deployed by accident. A real app passes
> `auth: () => authBlock.requireAuth(context)`.

> **Trusted server code bypasses RLS.** `lib/notes.ts` queries directly — that's the
> design: RLS gates *untrusted* callers. Server code scopes its own queries.

## Types come from the migrations

`lib/schema/` is generated. Start `npm run dev`, add a column to a migration, save, and the
row type has it — no command, no codegen step:

```sql
-- migrations/002_add_priority.sql
ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
```

```ts
import type { Notes } from './schema/database.types';
//          ^ now has `priority: number`
```

The generated files are **committed** so a fresh clone typechecks and editors have types
before the dev server has ever run. `test/schema-fresh.test.js` fails if they drift from the
migrations, the same way `check:api` guards `API.md`.

## The two rules that make it safe

**1. `import 'server-only'` in any module that constructs blocks.** Nothing structural
stops a Client Component from importing `lib/backend.ts` — it's just a file. That import
is what turns the mistake into a build error rather than an AWS SDK and a Postgres WASM
binary in your browser bundle. `test/no-server-leak.test.js` asserts the outcome by
scanning the built client chunks.

**2. Gate every Server Action.** A Server Action is a public HTTP endpoint; anyone who can
reach the site can invoke it. "It's server code" is not access control. This POC has no
auth block yet, so its actions validate input instead — see `src/app/actions.ts`. A real
app calls `await auth.requireAuth(context)` first.

## Scope

Local dev only. Deploy is phase C, which still has to resolve `aws-runtime` inside the SSR
Lambda and retarget IAM grants to the SSR function. Two known deploy-path gaps: `bb-data`'s
export map has no `react-server` key, so in the RSC graph it currently falls through to the
mock; and `migrationsPath` reads from the working directory, which the standalone output
does not trace.

Phase F adds browser-direct, RLS-gated queries with no hand-written endpoint.

## Queries are checked against the schema

`lib/notes.ts` uses the fluent client, so table and column names are compile-time checked:

```ts
data.from('notes').select('id', 'text', 'done').order('id', 'desc')
```

`lib/type-checks.ts` proves this is load-bearing rather than decorative. Nothing imports
it — `npm run typecheck` is the assertion, and every `@ts-expect-error` in it fails the
build if the error it expects ever stops happening. It covers unknown tables and columns,
wrong value types, `select()` narrowing, and inserts that try to set a database-managed
column.
