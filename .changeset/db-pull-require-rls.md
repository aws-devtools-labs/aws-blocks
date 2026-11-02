---
"@aws-blocks/bb-data": minor
---

**Breaking (behavior):** `db pull` no longer generates CRUD for tables with row-level security (RLS) disabled.

Generated CRUD relies on row-level security to decide which rows each user can access, and PostgreSQL applies no row filtering to a table without RLS. `db pull` and the `npm run dev` type refresh now skip these tables. The `db pull` eligibility table shows `No — RLS disabled` for them, and both commands print a warning that names each skipped table with the `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` statement to run.

If you re-pull a project that already has CRUD for a table without RLS, that table disappears from `database.types.ts` and `database.meta.ts`, and code that uses it stops compiling. To keep it, enable RLS and add policies for the table in a migration, then re-run `db pull`.
