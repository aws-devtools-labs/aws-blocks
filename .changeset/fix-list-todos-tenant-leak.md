---
"@aws-blocks/create-blocks-app": patch
---

Fix multi-tenant data leak in demo template: `listTodos()` no longer falls back to `scan()` when no `sortBy` is provided. All paths now use `query()` with a `userId` filter, ensuring users only see their own todos.
