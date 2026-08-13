---
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
---

Bundle the migration lambdas through `blocksNodejsBundling()` so `import.meta.url` used anywhere in the bundled migration handler is shimmed to its CommonJS equivalent instead of throwing at Lambda load. Consistent with the backend handler; no behavior change for existing migration lambdas. Also documents in the README that `migrationsPath` is simplest as a path relative to your project root, and that `import.meta.url` inside the bundle resolves to the bundled output (not your source tree).
