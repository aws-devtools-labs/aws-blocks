---
"@aws-blocks/create-blocks-app": minor
---

feat(create-blocks-app): add `sql` and `api-only` starter templates

Two new headless scaffolds, so `npm create @aws-blocks/create-blocks-app` can
start from a shape closer to what you are building:

- **`sql`** — a PostgreSQL backend on the `Database` Building Block. A relational
  notebooks → notes model with a foreign key (`ON DELETE CASCADE`), per-user
  ownership, parameterized `sql` queries, and a transaction, defined in
  version-controlled `.sql` migrations. PGlite locally, Aurora Serverless v2 on
  deploy.
- **`api-only`** — a headless JSON API service: a public health check plus an
  auth-gated CRUD resource over a `DistributedTable`, no frontend. The starting
  point for a backend behind a mobile app, CLI, or third-party client — a service
  skeleton, unlike the bare `backend` greet stub.

Both are registered in the template list; `crud` and `realtime` are intentionally
not added — the `default` and `demo` templates already ship full CRUD + auth +
Realtime.
