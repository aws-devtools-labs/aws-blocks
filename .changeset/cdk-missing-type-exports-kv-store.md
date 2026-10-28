---
"@aws-blocks/bb-kv-store": patch
---

fix: export a type missing from the `cdk` entry point

A type exported by the default entry point of `@aws-blocks/bb-kv-store` was missing from its `cdk` entry, so
backend code importing it failed to type-check under that condition — for example,
`import type { ScanOptions } from '@aws-blocks/bb-kv-store'`.

The `cdk` entry now exports `ScanOptions`.
