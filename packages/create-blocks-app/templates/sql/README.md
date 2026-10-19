# Blocks SQL Application

Backend-only TypeScript API on a full PostgreSQL database — the AWS Blocks
`Database` Building Block. Relational modeling with foreign keys, transactions,
and version-controlled SQL migrations. No frontend included.

> Created with `npx @aws-blocks/create-blocks-app my-app --template sql`

## For Coding Agents

**CRITICAL: Always read documentation from `node_modules/@aws-blocks/blocks/README.md` to understand the Building Block system and available APIs.**

**After making code changes, always run `npm run typecheck` to verify TypeScript types are correct.**

The `Database` API and migration model are documented in
`node_modules/@aws-blocks/bb-data/README.md`.

## What ships

- **`aws-blocks/index.ts`** — a relational **notebooks → notes** API: create/list
  notebooks, add/list notes, and delete a notebook (cascading to its notes in a
  transaction). Every query is parameterized via the `sql` tagged template
  (injection-safe) and scoped to the signed-in user.
- **`aws-blocks/migrations/`** — the schema as numbered `.sql` files:
  - `001_create_notebooks.sql` — notebooks, unique name per owner
  - `002_create_notes.sql` — notes, foreign key to notebooks with `ON DELETE CASCADE`
- **Auth** — `AuthBasic` gates every method; callers sign up, then their data is
  isolated by owner.

## The database

| Environment | Engine | Storage |
|-------------|--------|---------|
| `npm run dev` | PGlite (WASM PostgreSQL) | `.bb-data/` (gitignored) |
| `npm run sandbox` / `npm run deploy` | Aurora Serverless v2 | AWS, scales to zero |

Migrations run automatically — on first query locally, and via a CustomResource
Lambda on deploy. Applied files are tracked in a `_migrations` table and each
runs once. Add a migration by dropping a higher-numbered `.sql` file into
`aws-blocks/migrations/`.

## Commands

```bash
npm run typecheck   # Check TypeScript types (run after code changes)
npm run dev         # Local dev server on http://localhost:3001 (long-running)
npm run sandbox     # Deploy to AWS sandbox (Aurora Serverless v2)
npm run deploy      # Deploy to production
npm run test:e2e    # Run end-to-end tests against the dev server
npm run sandbox:destroy  # Tear down the AWS sandbox stack
npm run destroy          # Tear down the production stack
```

### RPC endpoint (local dev)

```bash
# JSON-RPC 2.0 at POST /aws-blocks/api. Auth methods are on the auth namespace.
curl -X POST http://localhost:3001/aws-blocks/api \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"api.listNotebooks","params":[],"id":1}'
# method = "<namespace>.<methodName>"; params = positional array.
# Errors return HTTP 200 with an {"error":{...}} body (JSON-RPC), not a non-2xx status.
```

## Connecting to an existing database

`Database` can point at an existing PostgreSQL (Supabase, Neon, RDS) instead of
provisioning Aurora — see `fromExisting()` in
`node_modules/@aws-blocks/bb-data/README.md`.

## Stack naming

Your CloudFormation stack names derive from the `stackId` in
`.blocks/config.json`, generated at scaffold time. Edit `stackId` to rename, or
`aws-blocks/index.cdk.ts` for dynamic naming logic.

## Adding a frontend later

This template is backend-only. The `backend` template's README documents adding a
Vite/React frontend and `Hosting` — the same steps apply here.

**Read `node_modules/@aws-blocks/blocks/README.md` for complete documentation.**
