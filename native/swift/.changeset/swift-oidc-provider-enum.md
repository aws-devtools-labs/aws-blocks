---
"aws-blocks-swift": minor
---

feat(swift): type `OIDCClient` by the spec's provider names

**Breaking:** `OIDCClient` is now generic over the providers
`signIn(provider:relayTo:launcher:)` takes. A direct or optional `oidc/client`
result whose `x-blocks-type-args[0]` is a string enum generates a `CaseIterable`
`Provider` enum in the method's namespace and returns
`OIDCClient<OidcAuthApi.GetClient.Provider>`, so `signIn(provider: .google, ...)`
accepts only that client's own providers and a typo doesn't compile. An untyped
spec returns `OIDCClient<String>`, whose `signIn` still takes a `String`. Write
`OIDCClient<String>` (or the generated enum) where code names `OIDCClient`,
including for its static members, as in `OIDCClient<String>.generateVerifier()`.
The new `OIDCProviderName` protocol is what a provider type conforms to.

When the method's own types already use the name `Provider`, the enum is
`ResultProvider` and codegen prints a `swift:` warning that names it. A nested
`oidc/client` still decodes as `JSONValue` and gets no enum. A namespace that
would generate a class named `CaseIterable` now takes an `Api` suffix.
