---
'@aws-blocks/bb-kv-store': patch
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

docs: state guarantees and helpers in the words people search for

- KVStore "Conditional writes" now says that a conditional `put` / `delete` is atomic for its item (one DynamoDB conditional write on AWS; no interleaving between the check and the write in the local mock), that there is no transaction across items (a batch call can partially succeed on AWS), and that `Database` / `DistributedDatabase` `transaction()` is the option for one.
- The `withAuth` section of the core README names what the built-in detection uses: `cookies()` from `next/headers` (server components, route handlers, server actions) and Nuxt's Nitro request context.
- The guide's Reference section lists the Node test helpers in `@aws-blocks/blocks/utils` (`installCookieJar`, `createTestClient`, `getLastAuthCode`, `totpCodeFor`, `isServerRunning`) with their signatures.
- `TROUBLESHOOTING.md` explains the dev server's `Frontend server unavailable` (502) response and its startup messages, the messages for a second dev server and a port in use, and the 403 / 404 / 415 responses for a disallowed `Host`, a cross-origin call, a non-`POST` RPC call and a non-JSON `Content-Type`.
