---
"@aws-blocks/data-common": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-agent": patch
---

Fix `ERR_MODULE_NOT_FOUND` on a fresh `create-blocks-app` scaffold by promoting required runtime packages from peer/dev dependencies to real dependencies.

`kysely` (imported unconditionally by `data-common`'s Kysely adapter, which `bb-data` and `bb-distributed-data` re-export) and `@opentelemetry/api` (a non-optional peer of `@strands-agents/sdk`, loaded by `bb-agent`) were previously not installed by `npm install` because npm does not resolve peer dependencies of transitive dependencies. They are now direct dependencies of the blocks that load them, so `npm run dev` works without manual installs.
