---
"@aws-blocks/create-blocks-app": patch
---

The `AGENTS.md` that `create-blocks-app` adds to every new app now covers facts that coding agents often missed in the block docs:

- **Namespaces:** a requested call such as `orders.create(...)` maps to an exported `orders` namespace.
- **Errors:** a named `ApiError` reaches the client with its status and name, while a plain `Error` becomes an unnamed `500`.
- **Client-side imports:** browser code and tests import `ApiError` and `isBlocksError` from `@aws-blocks/blocks/client`, because `@aws-blocks/blocks` exports nothing under the browser condition. Check `instanceof ApiError` before reading `.status`.
- **Missing items:** `get()` returns `null` for a missing item, and `FileBucket.getUrl()` does not check that the file exists.

A new "Block specifics" section covers `Secret` caching, rotation and named secrets; `DistributedTable` cursor pagination and conditional writes; schema defaults for existing rows; and the `AuthBasic` password, session and lockout options. The Quick Reference now lists which imports come from `@aws-blocks/blocks` and which from `@aws-blocks/blocks/client`. The workflow explains how `npm run test:e2e` starts and stops its own dev server on the configured port.
