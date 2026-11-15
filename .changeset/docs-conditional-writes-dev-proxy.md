---
'@aws-blocks/bb-distributed-table': patch
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-app-setting': patch
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

docs: say which writes are atomic, and what a local `502 Frontend server unavailable` means

- `DistributedTable` and `KVStore`: a conditional `put` or `delete` (`ifNotExists`, `ifExists`, `ifFieldEquals` / `ifValueEquals`) is an atomic check-and-write on one item or key on AWS (and, for `KVStore`, in the local mock). It is not a multi-item transaction; for one, use `DistributedDatabase` or `Database`. KVStore's Local Development section says how the mock handles concurrent conditional writes, both say where the mock keeps its data, and DistributedTable's says how `limit` behaves locally. A failed condition serializes to JSON-RPC 409, and to HTTP 409 only with `httpErrorStatus: true`; the error tables said HTTP 409.
- Troubleshooting: what the local dev server's `502 Frontend server unavailable` means and how to fix each cause.
- Core: `withAuth` reads the request's cookies with Next.js `cookies()` from `next/headers` itself, and a `RawRoute` fills `params` the same way under `npm run dev` and deployed.
- `AppSetting`: its mock keeps values in the shared `.bb-data/settings.json`, not `.bb-data/settings/{fullId}/value.json`.
