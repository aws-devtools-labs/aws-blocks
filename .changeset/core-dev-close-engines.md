---
"@aws-blocks/core": patch
"@aws-blocks/data-common": patch
---

fix(core,data-common): the dev server closes its local databases when it stops

The local PGlite engines (bb-data, and the DSQL mock) close on Node's `beforeExit`, which `process.exit()` skips. The dev server ends with `process.exit()`, so every stop, Ctrl-C and `cdk-blocks dev stop` included, left PostgreSQL's `postmaster.pid` in `.bb-data`, and every start printed `Removed stale postmaster.pid`. A leftover lock therefore could not tell a crash from a stop.

- The dev server now closes those engines when it stops or reloads, while it stops the frontend, waiting at most 3 seconds. Only a crash or a SIGKILL leaves `postmaster.pid` behind.
- `closeOnProcessExit()` keeps its closers in one process-wide set (`Symbol.for('aws-blocks.local-engine-closers')`), shared by every copy of `@aws-blocks/data-common`, which the dev server runs. New export from core's dev-server module: `closeLocalEngines()`.
