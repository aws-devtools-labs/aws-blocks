---
'@aws-blocks/bb-data': patch
'@aws-blocks/bb-distributed-data': patch
'@aws-blocks/data-common': patch
'@aws-blocks/blocks': patch
---

Scripts that use a local `Database` or `DistributedDatabase` now exit when they finish. Before, a short-lived script that imported your backend under local development (a seed script, a one-off CLI step, a test) kept running forever after its last query, because the local database engine held the process open. The local engine also now shuts down cleanly when the process exits, so the next start no longer logs `Removed stale postmaster.pid`. Your local data in `.bb-data/` persists as before, and `npm run dev` is unaffected: the dev server keeps running and serving queries until you stop it.
