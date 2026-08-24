---
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

Default the shared Blocks handler Lambda to **arm64 (AWS Graviton)**.

Adds `lambdaArchitecture: Architecture` to `BlocksDefaults` (and to `BlocksPresets` — `Architecture.ARM_64` in both `sandbox` and `production`), and applies it to the framework-provisioned handler in `BlocksStack` / `BlocksBackend`. arm64 Lambda is ~20% cheaper per GB-second than x86_64 at equivalent performance, and the backend is a pure-JavaScript esbuild bundle with no architecture-specific native dependencies, so the switch carries no runtime risk.

Override per stack when you bundle an x86-only native addon:

```ts
import { Architecture } from 'aws-cdk-lib/aws-lambda';
defaults: { ...BlocksPresets.production, lambdaArchitecture: Architecture.X86_64 }
```

> **Behavior change on next deploy of an existing app:** the handler function's architecture flips from `x86_64` to `arm64` (an in-place update — no new function). This also adds a new field to the public `BlocksDefaults` `@aws-blocks/core/cdk` surface (both presets set it), which wants API-BR sign-off before release.
