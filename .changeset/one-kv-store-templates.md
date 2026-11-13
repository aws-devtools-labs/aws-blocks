---
"@aws-blocks/create-blocks-app": minor
---

feat(templates): scaffold data models on `KVStore` with a `schema` and a `key`

The default, react, api-only, auth-cognito, demo and bare templates and the scaffolded `AGENTS.md` now use `KVStore` with a declared key for records that an app lists or queries as a collection, in place of `DistributedTable`. Calls are key first (`todos.put({ userId, todoId }, todo)`), and `query` yields `{ key, value }` entries.
