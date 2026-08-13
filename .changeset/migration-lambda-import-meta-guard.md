---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
---

Harden the migration-lambda bundling with `blocksNodejsBundling()` so `import.meta.url` used anywhere in the bundled migration handler fails `cdk synth` instead of throwing at Lambda load. Defense-in-depth consistent with the backend handler guard; no behavior change for existing migration lambdas. Also documents in the README that `migrationsPath` should be a path relative to your project root and must not be derived with `fileURLToPath(import.meta.url)` (empty under the CommonJS Lambda bundle).
