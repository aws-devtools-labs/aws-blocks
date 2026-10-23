---
"@aws-blocks/bb-distributed-table": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/bb-distributed-table` were missing from its `cdk` entry,
so backend code importing them failed to type-check under that condition — for example,
`import type { KeyCondition } from '@aws-blocks/bb-distributed-table'`.

The `cdk` entry now exports `PartitionKeyCondition`, `SortKeyCondition`, `KeyCondition`.
