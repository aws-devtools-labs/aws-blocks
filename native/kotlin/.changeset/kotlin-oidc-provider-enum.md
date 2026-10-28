---
"aws-blocks-kotlin": minor
---

Type `OidcClient` by the spec's provider names

When a spec names an OIDC client's providers, the method's object gets a `Provider` enum that
implements the new `OidcProvider` interface, whose constants carry the names the backend knows them
by, and `getClient()` returns `OidcClient<AuthApi.GetClient.Provider>`, so
`client.signIn(AuthApi.GetClient.Provider.Google)` takes only that client's own providers and a
typo no longer compiles. A provider name that is not a legal identifier is still spelled as one and
keeps the name it signs in with — `login.gov` becomes `LoginGov("login.gov")`. When the method's
object already uses the name `Provider`, the enum is `ResultProvider` and code generation warns.

A spec that does not name them, and a client nested inside another type, are
`OidcClient<ProviderName>`, whose `signIn` and `exchange` take a provider name as before.

**`OidcClient` is now generic, so a bare `OidcClient` in a type position no longer compiles.** Write
`OidcClient<ProviderName>` for an untyped spec, or `OidcClient<AuthApi.GetClient.Provider>` for a
typed one. Kotlin has no default type arguments, so there is no non-breaking spelling of the
generic.
