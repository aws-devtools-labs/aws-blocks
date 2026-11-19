---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
"@aws-cdk-blocks/create-block": patch
---

docs(blocks,create-blocks-app,create-block): the guide and the scaffolder READMEs state one rule per list item or table row, with corrected defaults, and each template README keeps only what is specific to its template.

**`aws-cdk-blocks` (guide README)**

- Corrected: the security list said WAF and API Gateway throttling are not included by default. Throttling is on by default (`defaults.throttling`). WAF is off by default and is enabled with `apiWaf: { enabled: true }` on `BlocksStack` or `BlocksBackend`, or with `frontDoor: { features: { waf: { enabled: true } } }` on `Hosting` when its CloudFront distribution serves the API.
- Corrected: least-privilege credentials are scoped to "the services your app deploys", not "your cdk-blocks deploy".
- Added: tables for the `blocks.dev` keys with defaults, the detected frontend commands in detection order, the JSON result of each task and of each `npm run docs` call, and the migrate exit codes. "AWS credentials", "Deployment target", "CDK bootstrap", "Deploy progress and signals", "Global options" and "Telemetry" are subsections with one rule per item.
- Moved: the details of what `npm run migrate` rewrites, keeps and deletes are in `MIGRATING-FROM-SCRIPTS.md`, which ships with the package, in seven sections. The test helpers table is under "Testing". "Testing", "Best practices", "Security Considerations" and "VPC Support" come before "Local development and deploying".
- Removed: "Common mistakes" (each item is stated in "How it works", "Adding auth and data", "Choosing a data block" or "Best practices"); the Cognito price column (`npm run docs Auth` has the prices); the IAM hardening report details (`npm run docs core`).

**`@aws-cdk-blocks/create-blocks-app`**

- Corrected in the README: the link to the guide's migration section; the backend-only templates include `observability`; the Amplify overlay's `blocks.dev` includes `generateClient: false`; an existing project gets every Blocks task, and a task whose script name is taken is added as `blocks:<name>`; the CLI is released with every `aws-cdk-blocks` release at the same version number.
- Added to the README: a table of the argument and options, including `--skip-install` and `-y`/`--yes`, and a table of the scripts and `blocks.dev` value per mode.
- Moved: the contributor notes on template registration and dependency ranges are in `DESIGN.md` in the repository.
- Removed from the README: the listings of `cdk-blocks/index.ts` and `cdk-blocks/index.cdk.ts`, the full script list, and the dev server, `destroy` and output-format text that the guide states.
- The `AGENTS.md` copied into every scaffolded app gains three sentences: update `test/e2e.test.ts` when the API changes and never delete `test/` or the `test:e2e` script; get `npm run test:e2e` passing before every `npm run deploy`; add a functional check to `test/e2e.test.ts` instead of calling the local API with curl or fetch.
- Template READMEs, corrected: the "Adding a Frontend Later" recipe in `backend`, `cron` and `observability` lists the dependency versions of the `react` template; `api-only` and `sql` point to `npm run docs Hosting` instead of a README the app does not contain; `default` names the sections of its test file; `nextjs` says `await auth.requireAuth(context)`.
- Template READMEs, removed: the command tables, the stack naming section, the dev server settings and the paragraphs on storage, start files and JSON-RPC, which the app's `AGENTS.md` and `npm run help` state. `auth-oidc` and `demo` have a "Before deploying to production" section.

**`@aws-cdk-blocks/create-block`**

- The generated block README has an `## Errors` table seeded with `InvalidInput`, a `Default` column in the options table, and `TODO` markers on the paragraphs to replace.
