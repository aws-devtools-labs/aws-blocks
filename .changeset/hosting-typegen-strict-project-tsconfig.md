---
"@aws-blocks/hosting": patch
---

fix(hosting): infer schema-typed `config()` and `secret()` types with the tsconfig that compiles each file

`cdk-blocks generate types` and the dev server read the `tsconfig.json` in the app root. When that root only lists project references, as create-vite apps and the AWS Blocks Vite templates do, it has no compiler options of its own, so the inferred types lost `strictNullChecks`: `z.number().nullable()` became `number` instead of `number | null`, and `.optional()` lost its `| undefined`. The typegen now uses the tsconfig that compiles each scanned file (the nearest one, or the referenced project that lists the file), and its options always start from `strict: true`.
