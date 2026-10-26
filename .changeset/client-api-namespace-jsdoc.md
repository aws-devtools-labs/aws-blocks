---
"@aws-blocks/core": patch
---

docs(core): name the `ApiNamespace` constructor's second parameter `label` and document it

The second `new ApiNamespace(scope, label, handler)` parameter is now named `label`, and its JSDoc says that
clients never send it: they call a namespace by the name it is exported under from the backend module, so
`export const api = new ApiNamespace(scope, 'todos', handler)` is called as `api.list()`.
`BlocksRequest.apiNamespace` now refers to the constructor's `label` argument. No runtime change.
