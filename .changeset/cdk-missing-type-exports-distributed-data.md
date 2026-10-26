---
"@aws-blocks/bb-distributed-data": patch
---

fix: export a type missing from the `cdk` entry point

A type exported by the default entry point of `@aws-blocks/bb-distributed-data` was missing from its `cdk` entry,
so backend code importing it failed to type-check under that condition — for example,
`import type { TransactionOptions } from '@aws-blocks/bb-distributed-data'`.

The `cdk` entry now exports `TransactionOptions`.
