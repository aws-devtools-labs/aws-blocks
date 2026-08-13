---
"@aws-blocks/core": patch
---

Fail `cdk synth` when bundled handler code uses `import.meta.url`. The backend handler is bundled to CommonJS, where `import.meta` is empty, so `fileURLToPath(import.meta.url)` in a customer handler, a Building Block's `aws-runtime` code, or a dependency became `fileURLToPath(undefined)` and threw at Lambda load. esbuild only *warned* about this, so the broken bundle deployed and failed on first invocation. The handler bundling now promotes esbuild's `empty-import-meta` warning to an error, so the build fails loudly and points at the exact offending file and line.
