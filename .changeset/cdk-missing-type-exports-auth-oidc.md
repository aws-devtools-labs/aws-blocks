---
"@aws-blocks/bb-auth-oidc": patch
---

fix: export a type missing from the `cdk` and `aws-runtime` entry points

A type exported by the default entry point of `@aws-blocks/bb-auth-oidc` was missing from its `cdk` and
`aws-runtime` entries, so backend code importing it failed to type-check under that condition — for example,
`import type { OIDCClient } from '@aws-blocks/bb-auth-oidc'`.

The `cdk` and `aws-runtime` entries now export `OIDCClient`.
