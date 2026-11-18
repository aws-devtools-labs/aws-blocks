---
"@aws-blocks/bb-database": minor
"@aws-blocks/blocks": minor
---

`cdk-blocks db types --block <id>` writes the `Tables` interface for Kysely of a block that provisions its cluster, from the block's migration files (`aws-blocks/migrations/<id>`). It applies the files to a new local database in a temporary directory, so it needs no AWS account and does not touch `.bb-data/`. Pass `--type aurora` for a block on an `aurora` cluster.

`cdk-blocks db status --block <id>` lists the applied and the pending files in the block's local database; pass `--cluster <id>` for a block on a `DatabaseCluster`. It reads a copy of the database, so it is safe while `npm run dev` runs.
