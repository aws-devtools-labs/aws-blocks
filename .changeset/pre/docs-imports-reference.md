---
'aws-cdk-blocks': patch
---

docs: add `IMPORTS.md`, a generated "what to import from where" reference

`docs/IMPORTS.md` lists each app-facing entry of `aws-cdk-blocks` (the root, `/client`, `/ui`, `/theme`, `/server`, `/utils`, and `/cdk`, `/lambda-handler` and `/scripts`, which an app's generated `cdk-blocks/index.cdk.ts` and `index.handler.ts` import), where it runs, and every name it exports, marked value or type-only. It states the browser rule: code run under the `browser` condition (browser bundles, and the templates' `tsx -C browser` e2e tests) gets no values from the root entry, the only one with that condition. For each root value such code can still use, it says where to import it instead: a browser-safe entry such as `/client`, or the browser build of the block package that defines it (its error constants and pure helpers, e.g. `KVStoreErrors` from `@aws-cdk-blocks/bb-kv-store`). It is generated from the built declaration files (`npm run update:imports`), and a test fails when it no longer matches the exports. The guide's Reference section links to it, and its test-helpers entry now says `/utils` also serves the `tsx -C browser` e2e tests.
