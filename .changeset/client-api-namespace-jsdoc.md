---
"@aws-blocks/core": patch
---

docs(core): document `BlocksRequest.apiNamespace` as the backend export name

`BlocksRequest.apiNamespace` is the name the namespace is exported under from the backend module,
which is how Lambda and the local dev server dispatch RPC calls. For
`export const api = new ApiNamespace(scope, 'todos', handler)`, `api.list()` sends the method `api.list`.
