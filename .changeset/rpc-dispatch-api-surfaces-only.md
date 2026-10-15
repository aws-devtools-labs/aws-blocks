---
"@aws-blocks/core": patch
---

fix(core): RPC dispatch only reaches API surfaces — never an exported Building Block instance or an inherited `Object.prototype` member

The Lambda handler and the local dev server resolved `backend[apiNamespace][method]`
straight off the backend module. Two consequences:

- An exported **Building Block instance** (`export const todos = new DistributedTable(...)`)
  exposed its whole data plane (`todos.put` / `todos.delete` / `todos.query`) as an
  unauthenticated RPC surface, bypassing every `requireAuth` in the `ApiNamespace` layer.
- The method-existence check walked the prototype chain, so `toString`, `constructor`,
  `hasOwnProperty` and friends passed it.

Both dispatchers now share one guard: the namespace must be an own, non-`_`-private
export that is not a Building Block (`Scope`) instance, and the method must be a
callable that does not come from `Object.prototype`. These are exactly the exports
`generate-client` already refuses to proxy, so no generated client is affected;
`ApiNamespace` exports and plain exported functions/objects keep working.
