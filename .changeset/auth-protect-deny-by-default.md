---
'@aws-blocks/bb-auth': minor
'@aws-blocks/blocks': patch
'@aws-blocks/core': minor
'@aws-blocks/create-blocks-app': patch
---

`Auth` has `protect()`, for an API namespace that is deny by default. `auth.protect(scope, 'notesApi', { public: (context) => ({ ...methods }), methods: (context, user) => ({ ...methods }) })` returns an ordinary `ApiNamespace`. For each call to one of its `methods`, the session is checked first, and only then is the `methods` factory called, once, with the signed-in user, typed by the block's options (`AuthenticatedUser<O>`). So nothing in it runs for a signed-out caller, and a forgotten guard, or one called without `await`, can no longer leave a method open. A signed-out call to any name that isn't a `public` method gets 401 `NotAuthenticatedException`, whether or not the method exists, so the protected methods can't be listed without a session; a signed-in caller gets "method not found" for an unknown name. `public` methods (optional) run as in a plain `ApiNamespace`. A name defined in both is a compile error. With `{ role: 'admin' }` as the last argument, every protected method also requires that group, as `requireRole` does (401 first, then 403 `NotAuthorizedException`); `compute` and every other `ApiNamespace` option go in the same object and are passed on to the namespace. It works the same locally and on AWS, and the frontend calls every method like any other namespace. Existing `ApiNamespace` code is unchanged.

The OpenRPC spec (`blocks-generate-spec`) describes every method of a `protect()` namespace, public and protected, and warns, naming the namespace, if it can't list them. It also now describes the parameters of a namespace typed through a mapped type, such as one returned by a factory, by name and type, instead of as a single `args` parameter.

The `Auth` README has a "Protect every method" recipe. The `ApiNamespace` docs and the scaffolded `AGENTS.md` now recommend `auth.protect` for namespaces with signed-in methods, and say that a guard which isn't awaited protects nothing. The templates don't add a floating-promise lint rule: Biome's `noFloatingPromises` doesn't flag an un-awaited `requireAuth` / `requireRole` call, so `protect` is the safeguard.
