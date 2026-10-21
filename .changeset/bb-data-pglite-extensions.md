---
"@aws-blocks/bb-data": minor
"@aws-blocks/blocks": minor
---

feat(bb-data): load Postgres extensions (PostGIS, pgvector) in local dev

Adds an `extensions` option to `DatabaseOptions` so a Database Block can declare
the Postgres extensions it uses (e.g. `['postgis']`, `['pgvector']`) and have them
load in the **local PGlite engine**, restoring local/production parity for spatial
and vector workloads. Previously `CREATE EXTENSION postgis` worked once deployed to
Aurora but failed in local dev, forcing a sandbox deploy for every spatial/vector
iteration.

- **Local-only, mirroring `postgresVersion`.** The option is read only by the local
  PGlite implementation and is a no-op on AWS, where Aurora PostgreSQL supports
  these extensions natively. Application code is unchanged across environments, and
  PGlite never leaks into app code.
- **Opt-in install.** Each supported extension ships as its own package, declared as
  an **optional peer dependency** and loaded by dynamic import, so only projects
  that declare an extension install it: `postgis` → `@electric-sql/pglite-postgis`,
  `pgvector` → `@electric-sql/pglite-pgvector`. A declared extension whose package is
  missing (or an unknown name) fails on the first database interaction with an
  actionable error — the exact `npm install` command, or the list of supported names.
- You still run `CREATE EXTENSION <name>` in a migration — the option only makes the
  extension available for `CREATE EXTENSION` to succeed locally.

Both extension packages are experimental upstream; the opt-in install keeps that
risk with the consuming app rather than every `bb-data` consumer. No change to the
AWS/CDK path. Non-breaking and additive: a `Database` with no `extensions` behaves
exactly as before.

The two extension packages are pinned to exact versions (`@electric-sql/pglite-postgis`
`0.2.11`, `@electric-sql/pglite-pgvector` `0.0.12`) to match the exact-pinned
`@electric-sql/pglite` `0.5.11` they peer-depend on. A caret range let a newer extension
release (whose `pglite` peer had moved on) float in and produce an unresolvable peer tree.
