---
"@aws-blocks/core": patch
"@aws-blocks/auth-common": patch
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/blocks": patch
---

Document four things people were reverse-engineering from compiled output.

- **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
- **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
- **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, and when to use it instead of the client PKCE API.
- **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour.
