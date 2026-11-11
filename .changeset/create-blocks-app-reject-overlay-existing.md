---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): reject overlay templates before integrating into an existing project

Running `create-blocks-app --template amplify` in a project with a `package.json` but no `amplify/backend.ts` now exits 1 with the overlay-template error before writing any files. Previously it created `aws-blocks/` and `.blocks/`, then crashed with `ENOENT` on the missing `cdk.json`, leaving files that made a re-run abort.
