---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

`ApiNamespace` RPC: stop leaking internal exception details to clients.

`errorResponseFromCatch` previously forwarded the raw `error.message` (and, for non-generic names, the exception class name in `data.name`) of **any** thrown value into the JSON-RPC error response. For the common case — a driver/SDK failure (Postgres, DynamoDB, …) rather than an `ApiError` — that put internal implementation details (table names, SQL fragments, ARNs, exception class names) on the wire to every caller.

Now only `ApiError` reaches the client verbatim (its status, message, `name`, and `retriable` flag are the public, `isBlocksError`-matchable contract). Every other throw collapses to a stable generic `{ code: 500, message: "Internal error" }` with no `data`. The full error is still logged server-side by the Lambda handler and the dev server, so debuggability is unchanged.

> Behavior change: clients that previously read the raw `message`/`data.name` of a non-`ApiError` failure now receive `"Internal error"` / code `500`. Throw an `ApiError` to send a specific, client-safe message.
