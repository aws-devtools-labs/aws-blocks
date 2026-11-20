---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
"@aws-cdk-blocks/create-block": patch
---

docs(blocks,create-blocks-app,create-block): the guide and the scaffolder READMEs state one rule per list item or table row, with corrected defaults, and each template README keeps only what is specific to its template.

**`aws-cdk-blocks` (guide README)**

- Corrected the API Gateway throttling defaults and distinguished a gateway-stage WAF from a WAF on the Hosting CloudFront distribution.
- Corrected: least-privilege credentials are scoped to "the services your app deploys", not "your cdk-blocks deploy".
- Added: tables for the `blocks.dev` keys with defaults, the detected frontend commands in detection order, the JSON result of each task and of each `npm run docs` call, and the migrate exit codes. "AWS credentials", "Deployment target", "CDK bootstrap", "Deploy progress and signals", "Global options" and "Telemetry" are subsections with one rule per item.
- Moved: the details of what `npm run migrate` rewrites, keeps and deletes are in `MIGRATING-FROM-SCRIPTS.md`, which ships with the package, in seven sections. The test helpers table is under "Testing". "Testing", "Best practices", "Security Considerations" and "VPC Support" come before "Local development and deploying".
- Removed: "Common mistakes" (each item is stated in "How it works", "Adding auth and data", "Choosing a data block" or "Best practices"); the Cognito price column (`npm run docs Auth` has the prices); the IAM hardening report details (`npm run docs core`).

**`@aws-cdk-blocks/create-blocks-app`**

- Corrected in the README: migration link, mode-specific scripts and dev settings, script collision handling, and linked release cadence.
- Added to the README: a table of the argument and options, including `--skip-install` and `-y`/`--yes`, and a table of the scripts and `blocks.dev` value per mode.
- Moved: the contributor notes on template registration and dependency ranges are in `DESIGN.md` in the repository.
- Removed from the README: the listings of `cdk-blocks/index.ts` and `cdk-blocks/index.cdk.ts`, the full script list, and the dev server, `destroy` and output-format text that the guide states.
- The scaffolded `AGENTS.md` asks agents to run the e2e test before deploying, check frontend changes in a browser, and add local API checks to the e2e suite rather than using ad hoc curl or fetch calls.
- The backend, cron and observability frontend instructions use the React template's root Vite and TypeScript layout and retain the backend test port. `api-only` and `sql` point to the app-facing Hosting section of the core docs; `default` names the sections of its test file; `nextjs` shows the awaited auth guard.
- Template READMEs, removed: the command tables, the stack naming section, the dev server settings and the paragraphs on storage, start files and JSON-RPC, which the app's `AGENTS.md` and `npm run help` state. `auth-oidc` and `demo` have a "Before deploying to production" section.

**`@aws-cdk-blocks/create-block`**

- The generated block README has an `## Errors` table seeded with `InvalidInput`, a `Default` column in the options table, and `TODO` markers on the paragraphs to replace.
