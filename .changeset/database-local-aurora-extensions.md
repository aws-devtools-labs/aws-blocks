---
"@aws-cdk-blocks/bb-database": patch
"aws-cdk-blocks": patch
---

A migration on a local `aurora` cluster can now run `CREATE EXTENSION` for the contrib extensions that PGlite ships and Aurora PostgreSQL supports, such as `citext`, `pgcrypto`, `pg_trgm`, `hstore`, and `uuid-ossp`. Before, it failed under `npm run dev` with `extension "citext" is not available`. An extension that PGlite does not ship, such as `vector`, still fails locally, and its error now lists the extensions that are available. A `dsql` cluster is unchanged.
