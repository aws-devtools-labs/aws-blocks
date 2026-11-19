---
'@aws-cdk-blocks/core': minor
'aws-cdk-blocks': minor
'@aws-cdk-blocks/hosting': minor
'@aws-cdk-blocks/create-blocks-app': minor
'@aws-cdk-blocks/admin-ui': minor
'@aws-cdk-blocks/bb-database': minor
'@aws-cdk-blocks/bb-app-setting': patch
'@aws-cdk-blocks/bb-async-job': patch
'@aws-cdk-blocks/bb-auth': patch
'@aws-cdk-blocks/bb-dashboard': patch
'@aws-cdk-blocks/bb-email-client': patch
'@aws-cdk-blocks/bb-file-bucket': patch
'@aws-cdk-blocks/bb-knowledge-base': patch
'@aws-cdk-blocks/bb-kv-store': patch
'@aws-cdk-blocks/bb-logger': patch
'@aws-cdk-blocks/bb-metrics': patch
'@aws-cdk-blocks/bb-realtime': patch
'@aws-cdk-blocks/bb-secret': patch
'@aws-cdk-blocks/bb-tracer': patch
'@aws-cdk-blocks/create-block': patch
---

**Breaking: the hidden `.blocks/` folder is renamed to `.cdk-blocks/`, and local Building Block data moves from `.bb-data/` into it.** An existing app renames the first itself. Rename the config file, not the folder: `mkdir -p .cdk-blocks && git mv .blocks/config.json .cdk-blocks/config.json`, then delete the empty `.blocks/`. `git mv .blocks .cdk-blocks` is wrong once `.cdk-blocks/` exists — and it does as soon as you run anything on the new version — because `mv` then moves the folder *into* it and you get `.cdk-blocks/.blocks/config.json`, which neither path reads. The second move is carried across for you.

`.cdk-blocks/config.json` holds the committed `stackId`, so the rename is not only local state. An app that has not renamed it yet still deploys and destroys: `getStackId` reads the pre-rename `.blocks/config.json` when the new one is absent, because the secret and config prefixes answer an unresolved id with unscoped names rather than failing. Only when neither file exists do both refuse, with `.cdk-blocks/config.json not found or missing stackId`, naming the path to create rather than guessing an id and creating a second production stack. A machine's telemetry installation id is not carried over, so it is minted again and the first-run notice prints once more. Also moved: `~/.blocks/config.json` to `~/.cdk-blocks/config.json`, `~/.blocks/telemetry/installation-id` to `~/.cdk-blocks/telemetry/installation-id`, `.blocks/deploy-history.jsonl` to `.cdk-blocks/deploy-history.jsonl`, and Hosting's generated `.cdk-blocks/hosting-values.d.ts` (`DEFAULT_TYPEGEN_OUT`) — run `npm run typegen` once and commit it at the new path, and change `.blocks/**/*.d.ts` to `.cdk-blocks/**/*.d.ts` in your tsconfig `include` — the templates ship the new path but an app scaffolded earlier does not, and without that edit `getSecret()`/`getConfig()` silently stop narrowing to your declared keys, with `typegen --check` still passing because it only compares file contents.

Mock data is now `.cdk-blocks/local/data/{fullId}/`, recorded as D-032, which supersedes D-001's rejection of that nesting. The first use of each block's store, and of the shared `settings.json`, copies that unit out of `.bb-data/` and never overwrites anything already in the new location; `.bb-data/` is left in place so an older CLI in the same checkout still reads it. The carry-over is recorded per unit, one marker file each under `.cdk-blocks/local/.carried-over.d/`, and runs once for each, so data you delete after upgrading stays deleted — copying whatever was missing would otherwise restore a `FileBucket` object you deleted, and the relation and WAL files Postgres had removed, on the next call. The record is written only after a unit's copy finishes, so an interrupted copy is retried rather than marked done. A project directory that cannot be written now fails with the path instead of silently looking like a project with no data.

The local database moves with it, under `.cdk-blocks/local/data/{fullId}/pglite/`. A populated legacy database is copied by that same carry-over, and a copy that did not arrive whole is refused at the point the directory is opened rather than recovered silently — an empty database is indistinguishable from a fresh project, so the next write would start a second copy of rows the project already had. `npm run db -- status` and `npm run db -- types` read the pre-consolidation directory too, so they still report a database that the owning block has not opened yet.

`.cdk-blocks/local/` ignores itself: a `.gitignore` of `*` is written when the directory is created, so your local data cannot be committed and no root `.gitignore` rule is needed for it.

The per-deploy state directory is renamed separately, because Hosting serves it as a public URL path. The native clients' `~/.blocks/<applicationId>` storage is a different directory and is unaffected.
