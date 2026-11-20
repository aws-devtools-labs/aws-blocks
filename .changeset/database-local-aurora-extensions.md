---
"@aws-cdk-blocks/bb-database": patch
"aws-cdk-blocks": patch
---

A migration on a local `aurora` cluster can now create PostgreSQL's contrib extensions. Under `npm run dev`, `CREATE EXTENSION citext` (or `pgcrypto`, `pg_trgm`, `hstore`, `"uuid-ossp"` and the others) used to fail with `extension "citext" is not available`, because the local PGlite database was started without any of its extension bundles, while the same migration ran on AWS. The PGlite of an `aurora` cluster now loads every extension that PGlite ships and Aurora PostgreSQL 16 and 17 support: `amcheck`, `bloom`, `btree_gin`, `btree_gist`, `citext`, `cube`, `dict_int`, `dict_xsyn`, `earthdistance`, `fuzzystrmatch`, `hstore`, `intarray`, `isn`, `lo`, `ltree`, `moddatetime`, `pg_buffercache`, `pg_freespacemap`, `pg_trgm`, `pg_visibility`, `pgcrypto`, `seg`, `tablefunc`, `tcn`, `tsm_system_rows`, `tsm_system_time`, `unaccent` and `uuid-ossp`. Loading them adds about 180 ms when an existing local database opens.

An extension that PGlite does not ship, such as `vector`, still fails locally. Its error now says that PGlite lacks the extension and lists the ones that are available. A `dsql` cluster is unchanged: it loads no extension, and `dsql-lint` still rejects `CREATE EXTENSION`.
