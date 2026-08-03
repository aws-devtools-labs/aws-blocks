---
"@aws-blocks/nextjs": patch
---

`withBlocks()` now keeps generated schema types in step with your SQL migrations while `next dev` runs. Edit a migration, save, and `db.query<Notes>(...)` knows the new column — no command, no codegen step to remember.

Enabled automatically when a `./migrations` directory exists, and writes to `./lib/schema` by default:

```ts
export default withBlocks({}, { schema: { migrationsPath: './db', outDir: './types' } });
// or turn it off
export default withBlocks({}, { schema: false });
```

Runs only under `next dev`: `next build` compiles the committed generated files rather than regenerating them, so a build never depends on spinning up a database. A migration with a syntax error is reported and the watcher keeps running, so a mid-edit file doesn't take the dev server down.

Requires `@aws-blocks/bb-data`, declared as an optional peer dependency — an app with no database doesn't need it, and schema sync is simply a no-op.
