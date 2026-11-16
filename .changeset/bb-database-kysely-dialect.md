---
"@aws-blocks/bb-database": minor
"@aws-blocks/data-common": patch
---

`@aws-blocks/bb-database/kysely` exports `DatabaseDialect`, a Kysely dialect for a `Database`: `new Kysely<Tables>({ dialect: new DatabaseDialect(db) })`. Kysely is an optional peer dependency of the block; the application installs it. Statements run through the block's engine, so they use the block's schema and fail with the same `DatabaseErrors` names, and affected-row counts come from the engine. A Kysely statement inside the block's `transaction()` callback runs in that transaction. Inside a Kysely transaction, run every statement on `trx`; in local mode a statement on the block or on the root Kysely instance fails after five seconds instead of waiting. Streaming is not supported.

The entry points of `@aws-blocks/bb-database` no longer load Kysely. The block imported the root of `@aws-blocks/data-common`, which loads the Kysely adapter. It now imports the new `@aws-blocks/data-common/core` entry, which has every root export except `createKyselyAdapter()`. The root entry of `@aws-blocks/data-common` is unchanged.
