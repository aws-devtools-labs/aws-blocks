---
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/bb-distributed-table': patch
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

docs: state guarantees and helpers in the words people search for

- KVStore and DistributedTable "Conditional Operations" now say that a conditional `put` / `delete` is atomic per item (one DynamoDB conditional write on AWS; no interleaving between the check and the write in the local mock), that there are no multi-item transactions (`putBatch` / `deleteBatch` are batch writes that can partially succeed), and that `Database` / `DistributedDatabase` `transaction()` is the multi-row option.
- The `withAuth` section of the core README names what the built-in detection uses: `cookies()` from `next/headers` (server components, route handlers, server actions) and Nuxt's Nitro request context.
- The guide's Reference section lists the Node test helpers in `@aws-blocks/blocks/utils` (`installCookieJar`, `createTestClient`, `getLastAuthCode`, `totpCodeFor`, `isServerRunning`) with their signatures.
- `TROUBLESHOOTING.md` explains the dev server's `Frontend server unavailable` (502) response and its startup messages, the port-in-use messages, and the 403 / 404 responses for a disallowed `Host` and a non-`POST` RPC call.
