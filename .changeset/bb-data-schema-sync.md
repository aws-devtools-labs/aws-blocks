---
"@aws-blocks/bb-data": patch
---

Add `@aws-blocks/bb-data/schema-sync`: derive TypeScript row types and runtime table metadata from your SQL migrations, with no command to run and no generated artifact to refresh by hand.

```ts
import { syncSchema } from '@aws-blocks/bb-data/schema-sync';

await syncSchema({ migrationsPath: './migrations', outDir: './lib/schema' });
```

Migrations stay the single source of truth. `syncSchema` applies them to a throwaway PGlite database, introspects the result, and writes `database.types.ts` plus `database.meta.ts`. It builds a throwaway database rather than reading your dev one for two reasons: PGlite is single-writer per data directory, so introspecting the running dev server's database would contend for its lock; and types should describe what the migrations produce, not whatever state a long-lived dev database has drifted into.

Files are only rewritten when their content actually changes, so calling this on every file-change event doesn't churn mtimes or retrigger a watching dev server. `@aws-blocks/nextjs` calls it from `withBlocks()` during `next dev`.

Also exports `introspectEngine(engine)`, which runs the existing `db pull` introspection against any already-connected engine instead of opening a new connection from a connection string.

Note on temporal columns: `syncSchema` types `timestamptz`, `timestamp` and `date` as `Date`, which is what both `pg` and PGlite return. The mapping used by `db pull` declares them `string` and is left unchanged here, since correcting it would break the typecheck of existing generated code.
