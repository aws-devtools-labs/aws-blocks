---
"@aws-blocks/create-blocks-app": patch
---

fix(create-blocks-app): keep `npm run build` working after you replace the sample API

The `bare`, `default`, `react`, `auth-cognito` and `demo` templates type-checked `test/` as part of `npm run build`, and those tests call the sample API the template ships with. Replacing that API with your own methods made the next build fail with a type error in `test/e2e.test.ts` before you had a chance to update the test.

`build` now type-checks the app's own sources (`src/`, `aws-blocks/` and the generated `.blocks` types) through a new `tsconfig.build.json`. `npm run typecheck` still uses `tsconfig.json` and covers `test/` too, so a test that still calls a removed method is reported there.
