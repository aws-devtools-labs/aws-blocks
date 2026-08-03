# @aws-blocks/nextjs

Next.js integration for [AWS Blocks](https://github.com/awslabs/aws-blocks). Wraps your
`next.config` so blocks work in server code.

```bash
npm install @aws-blocks/nextjs
```

```ts
// next.config.ts
import { withBlocks } from '@aws-blocks/nextjs';

export default withBlocks({ output: 'standalone' });
```

## The programming model

Blocks are plain module exports in your own app code. Server Components, Server Actions,
and route handlers all use them **directly, in process** — no RPC hop, no wrapper method
per query shape.

```ts
// lib/backend.ts
import 'server-only';

import { Scope } from '@aws-blocks/blocks';
import { Database } from '@aws-blocks/bb-data';

const scope = new Scope('my-app');
export const db = new Database(scope, 'main', { migrationsPath: './migrations' });
```

```tsx
// src/app/page.tsx — a Server Component queries the database directly
import { sql } from '@aws-blocks/bb-data';
import { db } from '@/lib/backend';

export default async function Home() {
  const notes = await db.query<{ id: string; text: string }>(sql`SELECT id, text FROM notes`);
  return <ul>{notes.map((n) => <li key={n.id}>{n.text}</li>)}</ul>;
}
```

Locally that runs against in-process PGlite — real Postgres, no Docker, no AWS account.

### `import 'server-only'` is not optional

A module that constructs blocks must never reach the browser bundle. The first line of
`lib/backend.ts` is what enforces that: if a Client Component imports it, the build fails
with a clear error instead of quietly bundling an AWS SDK — or PGlite — into your client
JavaScript.

Client Components reach the server through **Server Actions**, which Next.js already gives
you with types, serialization, and an endpoint:

```ts
// src/app/actions.ts
'use server';

import { sql } from '@aws-blocks/bb-data';
import { db } from '@/lib/backend';

export async function addNote(text: string) {
  await db.execute(sql`INSERT INTO notes (text) VALUES (${text})`);
}
```

> **A Server Action is a public HTTP endpoint.** It is reachable by anyone who can reach
> your site, so gate it the same way you would gate an API route — call your auth block
> first. Being "server code" is not access control.

`ApiNamespace` remains fully supported and is still the right boundary for SPAs, native
mobile clients, and non-JS consumers. What changes is that Next.js server code is no
longer forced through it.

## Types from your migrations, with no command

Your SQL migrations are the source of truth. While `next dev` runs, `withBlocks()` keeps
generated row types in step with them: add a column, save, and the type has it.

```sql
-- migrations/002_add_priority.sql
ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
```

```ts
import type { Notes } from '@/lib/schema/database.types';
//          ^ now includes `priority: number`
```

Enabled automatically when a `./migrations` directory exists; generated files go to
`./lib/schema`. Both are configurable, and it can be turned off:

```ts
export default withBlocks({}, { schema: { migrationsPath: './db', outDir: './types' } });
export default withBlocks({}, { schema: false });
```

Details worth knowing:

- **Commit the generated files.** A fresh clone then typechecks and editors have types
  before the dev server has ever run. Consider a CI check that regenerates and fails on a
  diff, so they cannot drift.
- **Dev only.** `next build` compiles the committed files rather than regenerating them, so
  a build never depends on spinning up a database.
- **Migrations are applied to a throwaway database**, not your dev one. PGlite is
  single-writer per data directory, and this way the types describe what the migrations
  produce rather than whatever state a long-lived dev database has drifted into.
- **A broken migration is reported, not fatal.** A syntax error mid-edit logs and the
  watcher keeps going.
- Requires `@aws-blocks/bb-data` (an optional peer dependency). Without it, or without a
  migrations directory, schema sync is a no-op.

## What `withBlocks()` does

Keeps blocks that load WASM or native assets out of the server bundle, by merging them
into `serverExternalPackages`.

Bundlers rewrite the `new URL(..., import.meta.url)` expression those packages use to
locate their assets. Without this, `bb-data` fails at runtime with `The "path" argument
must be of type string or an instance of Buffer or URL. Received an instance of URL` —
identically under Turbopack and webpack.

Your own `serverExternalPackages` entries are merged, never replaced:

```ts
export default withBlocks(
  { output: 'standalone', serverExternalPackages: ['my-native-dep'] },
  { serverExternalPackages: ['another-one'] },
);
```

## Module resolution, briefly

Next.js resolves a different export condition depending on which graph an import sits in.
Measured against Next 16 under both Turbopack and webpack:

| Context | Condition |
|---|---|
| Server Component · route handler · Server Action | `react-server` |
| Client Component, SSR pass | `import` |
| Client Component, browser bundle | `browser` |

The one that surprises people: the SSR pass of a Client Component resolves `import`, not
`browser`. If you hand-write an export map for a backend package, `import` must point
wherever `browser` points — otherwise Client Components get server code during SSR and
client code after hydration.

`test-apps/nextjs-resolution` in the repo asserts this contract in CI.

## License

Apache-2.0
