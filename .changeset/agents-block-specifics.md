---
"@aws-blocks/create-blocks-app": patch
---

The `AGENTS.md` that `create-blocks-app` adds to every new app now covers facts coding agents often missed in block docs. It explains how a requested call such as `orders.create(...)` maps to an exported namespace, and which errors reach the client: a named `ApiError` keeps its status and name, while a plain `Error` becomes an unnamed `500`. It also notes that `get()` returns `null` for a missing item, and that `FileBucket.getUrl()` does not check that the file exists. A new "Block specifics" section covers `Secret` caching and rotation, `DistributedTable` cursor pagination and conditional writes, schema defaults for existing rows, and the `AuthBasic` password, session and lockout options. The workflow now describes how `npm run test:e2e` starts and stops the dev server itself.
