---
"@aws-blocks/bb-secret": patch
---

fix: export types missing from the `cdk` entry point

Some types exported by the default entry point of `@aws-blocks/bb-secret` were missing from its `cdk` entry, so backend
code importing them failed to type-check under that condition — for example,
`import type { WritableSecret } from '@aws-blocks/bb-secret'`.

The `cdk` entry now exports `WritableSecret` and `SecretConstructor`.
