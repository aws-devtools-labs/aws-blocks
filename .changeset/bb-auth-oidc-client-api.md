---
'@aws-blocks/bb-auth': minor
---

Add `auth.createOidcApi()`, the native SDKs' OIDC client

Native apps (Swift, Kotlin, Dart) that signed in with a federated provider through `AuthOIDC`'s `oidcAuthApi.getClient()` had no equivalent on `Auth`. Export `auth.createOidcApi()` and they call `getClient()` again:

```ts
export const authApi = auth.createApi();
export const oidcAuthApi = auth.createOidcApi();
```

`getClient()` returns the same `oidc/client` descriptor `AuthOIDC` did. It carries this block's own sign-in routes, so a second block with its own `redirects.callbackPath` and `signOutPath` works too, and it lists the providers that can sign in in this runtime. The generated native clients type `signIn` by the block's provider ids, as they did for `AuthOIDC`. `createApi()` is unchanged.
