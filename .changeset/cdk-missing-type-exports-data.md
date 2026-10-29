---
"@aws-blocks/bb-data": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/bb-data` were missing from its `cdk` entry, so backend
code importing them failed to type-check under that condition — for example,
`import type { CrudOptions } from '@aws-blocks/bb-data'`.

The `cdk` entry now exports `PgClientEngineConfig`, `RLSContext`, `SubnetSelection`, `TableSchema`, `TableMetaEntry`,
`CrudOptions`, `CrudMethods`, `QueryOpts`, `TableTypeMeta`, `CrudAuthResult`.
