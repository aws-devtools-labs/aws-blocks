# bb-data Testing Strategy

Three layers of testing ensure `db pull` output is correct and stays correct:

| Layer | What it proves | Requires Supabase? | Runs when? |
|-------|---------------|-------------------|------------|
| Unit tests (`src/db-pull.test.ts`) | Generator logic handles edge cases | No | Every PR |
| Typecheck snapshot (`test-apps/db-pull-typecheck/`) | Generated output compiles against real package types | No | Every PR |
| Supabase E2E (`src/crud/db-pull-e2e.test.ts`) | Full pipeline works: introspect → generate → CRUD | Yes | CI (when `SUPABASE_DB_URL` is set) |

## Running locally

### Unit tests (no setup needed)

```sh
npm run build -w packages/bb-data
npm run test -w packages/bb-data
```

### Typecheck snapshot (no setup needed)

```sh
npm run build
npm run test -w test-apps/db-pull-typecheck
```

### Supabase E2E

Requires a Supabase project with the test schema applied.

```sh
# 1. Set the connection string (direct connection, port 5432)
export SUPABASE_DB_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"

# 2. Apply the test schema (idempotent — safe to run repeatedly)
npx tsx packages/bb-data/test/apply-schema.ts

# 3. Run the E2E tests
npm run build -w packages/bb-data
node --test packages/bb-data/dist/crud/db-pull-e2e.test.js
```

## Test schema

The schema lives in `test/fixtures/supabase-e2e-schema.sql`. It contains six tables designed to cover the edge cases that matter for `db pull`:

| Table | What it tests |
|-------|--------------|
| `todos` | `auth.uid()` in RLS policy → should be **skipped** by `db pull` |
| `composite_pk_items` | Multi-column primary key (`order_id`, `product_id`) |
| `no_pk_log` | No primary key → should be marked ineligible |
| `exotic_types` | Unmapped PG types (`citext`, `inet`, `tsvector`) |
| `reserved_cols` | Reserved-word column names (`order`, `group`, `select`) |
| `jwt_policy_table` | `auth.jwt()` in RLS policy → OIDC-compatible, should be **included** |

### Applying schema changes

All statements in the schema file are idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`). To add a new test table:

1. Add the DDL to `test/fixtures/supabase-e2e-schema.sql`
2. Run `npx tsx packages/bb-data/test/apply-schema.ts` against the test project
3. Add corresponding assertions in `db-pull-e2e.test.ts`

The CI workflow runs `apply-schema.ts` before the E2E job, so schema changes are applied automatically on every run.

### Port requirements

- **Schema apply and introspection** use port **5432** (direct connection / session mode). DDL statements (`CREATE EXTENSION`, `CREATE POLICY`) require session mode.
- **CRUD at runtime** uses port **6543** (transaction pooler). `SET LOCAL ROLE` + `set_config` inside `BEGIN...COMMIT` is transaction-scoped and safe for pooled connections.

The `SUPABASE_DB_URL` CI secret should use port 5432. The E2E test uses this same URL for both introspection and CRUD (acceptable for testing — both work on port 5432, just with lower connection limits).

## Typecheck snapshot

`test-apps/db-pull-typecheck/generated/` contains checked-in output from the generators. CI runs `tsc --noEmit` against these files to catch type regressions.

When you change the generators (`generateTypesFile`, `generateMetaFile`, `generateIndexFile`):

```sh
cd test-apps/db-pull-typecheck
npx tsx regenerate-snapshot.ts
```

Review the diff in `generated/`, verify it compiles (`npm run typecheck`), and commit alongside your generator changes.

## CI integration

The E2E tests are wired into `.github/workflows/pr-checks.yml`:

1. `npm ci` + `npm run build`
2. `apply-schema.ts` runs (skips gracefully if `SUPABASE_DB_URL` not set)
3. E2E Supabase job runs the test file

The typecheck snapshot runs as part of `npm run test:unit` (workspace `test` script → `tsc --noEmit`).
