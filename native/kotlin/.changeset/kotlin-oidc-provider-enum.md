---
"aws-blocks-kotlin": minor
---

Type `OidcClient` by the spec's provider names

When a spec names an OIDC client's providers, the method's object gets a `Provider` enum that
implements the new `OidcProvider` interface, whose constants carry the names the backend knows them
by, and `getClient()` returns `OidcClient<AuthApi.GetClient.Provider>`, so
`client.signIn(AuthApi.GetClient.Provider.Google)` takes only that client's own providers and a
typo no longer compiles. The enum's `fromProviderName(name)` reaches a constant from a name known
only at runtime, such as one read from a saved session. A provider name that is not a legal
identifier is still spelled as one and keeps the name it signs in with — `login.gov` becomes
`LoginGov("login.gov")`. When the method's object already uses the name `Provider`, the enum is
`ResultProvider` and code generation warns.

A spec that does not name them, and a client nested inside another type, are
`OidcClient<AnyProvider>`, whose `signIn` and `exchange` take a provider name as before.

**Breaking.** `OidcClient` is now generic, and the `google()` and `github()` helpers brand their
names as literals, so most apps get a typed client:

- `client.signIn("google")` no longer compiles for an app whose spec named its providers. Pass the
  generated constant: `client.signIn(AuthApi.GetClient.Provider.Google)`, or
  `AuthApi.GetClient.Provider.fromProviderName(name)` for a name only known at runtime.
- A bare `OidcClient` in a type position no longer compiles. Write `OidcClient<AnyProvider>` for an
  untyped spec, or `OidcClient<AuthApi.GetClient.Provider>` for a typed one. Kotlin has no default
  type arguments, so there is no non-breaking spelling of the generic.
- A hand-written `OidcClient.fromJson(...)` call needs its provider spelled —
  `fromJson<AnyProvider>(...)` — since nothing else infers it. Generated code always has a declared
  return type, so only hand-written calls are affected.
