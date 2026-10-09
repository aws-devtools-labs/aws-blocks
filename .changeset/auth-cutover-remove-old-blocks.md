---
'@aws-blocks/bb-auth': minor
'@aws-blocks/auth-common': minor
'@aws-blocks/blocks': minor
'@aws-blocks/core': minor
---

**Breaking: `AuthBasic`, `AuthCognito` and `AuthOIDC` are removed. Use `Auth`.** The `@aws-blocks/bb-auth-basic`, `@aws-blocks/bb-auth-cognito` and `@aws-blocks/bb-auth-oidc` packages are no longer part of AWS Blocks and receive no further releases. `Auth` (`@aws-blocks/bb-auth`, also exported from `@aws-blocks/blocks`) replaces all three.

`@aws-blocks/blocks` no longer exports `AuthBasic`, `AuthBasicErrors`, `AuthCognito`, `AuthCognitoErrors`, `AuthOIDC`, `AuthOIDCErrors`, `cognitoFederated`, `customOidc`, `google`, or the types `AuthBasicOptions`, `AuthBasicUser`, `AuthCognitoOptions`, `AuthFlowType`, `CognitoUser`, `MFAPreference`, `AuthOIDCErrorName` and `OIDCUser`. `getSdkIdentifiers()` no longer has overloads for `AuthCognito` and `AuthOIDC`; `getSdkIdentifiers(auth)` returns the user pool's `{ userPoolId, clientId }` (optional fields: an `Auth` with no user pool registers none).

**How to migrate.** From your app's root, run the codemod, then follow `MIGRATION.md` in `@aws-blocks/bb-auth`:

```bash
npx @aws-blocks/bb-auth migrate --dry-run   # preview the changes
npx @aws-blocks/bb-auth migrate             # rewrite the files
```

It rewrites imports, class names, options, renamed methods and error names, never changes a block's id, and leaves a `TODO(aws-blocks-auth-migrate)` comment wherever you have to decide something. Keep every block's id exactly as it is: the id names the deployed resources, and changing it replaces the user pool and deletes its users.

- **`AuthCognito`:** switching to `Auth` with the same id keeps your user pool, its users and their signed-in sessions.
- **`AuthOIDC`:** directly federated providers keep working and users keep their `userId`, but everyone signs in once more. A `cognitoFederated()` provider's user pool is replaced, so those users get a new `userId`; `MIGRATION.md` shows how to re-key their data.
- **`AuthBasic`:** there is no upgrade path for its users. Amazon Cognito can't import its password hashes, so every user signs up again. An existing `AuthBasic` session cookie is signed out and cleared on the next request, never an error.

**`BlocksAuth.requireRole(context, role)` is now required** (`@aws-blocks/auth-common`). It was optional only because `AuthBasic` and `AuthOIDC` had no roles. If you implement `BlocksAuth` yourself, add `requireRole`: throw 401 `NotAuthenticatedException` when there is no session and 403 `NotAuthorizedException` when the user isn't in `role`.

**Behaviour change: an exported Building Block instance is no longer callable over RPC** (`@aws-blocks/core`). Until now, a client could call the methods of any Building Block you export from `aws-blocks/index.ts` — for example `export const realtime = new Realtime(...)` let anyone call `realtime.publish` — and inherited members such as `constructor` or `toString` of an API's method object. Now a namespace must be an `ApiNamespace` (or a plain exported object or function that isn't a Building Block), only its own methods can be called, and anything else returns JSON-RPC `-32601` "Method not found". The generated clients never made such calls. If your app relied on one, wrap the methods you want to expose in an `ApiNamespace`.

Telemetry: `@aws-blocks/core` no longer counts `AuthBasic`, `AuthCognito` and `AuthOidc` as official Building Blocks; `Auth` is.
