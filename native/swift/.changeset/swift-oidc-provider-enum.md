---
"aws-blocks-swift": minor
---

feat(swift): generate an OIDC provider enum for typed sign-in

A direct or optional `oidc/client` result whose `x-blocks-type-args[0]` is a
string enum now generates a `CaseIterable` `Provider` enum in the method's
namespace (e.g. `OidcAuthApi.GetClient.Provider`) and an
`OIDCClient.signIn(provider:relayTo:launcher:)` overload that takes it, so
`signIn(provider: .google, ...)` checks the provider name at compile time. When
the method's own types already use the name `Provider`, the enum is
`ResultProvider` and codegen prints a `swift:` warning that names it.
`getClient()` still returns `OIDCClient`, and the `String` overload stays for
untyped specs. A nested `oidc/client` still decodes as `JSONValue` and gets no
enum. A namespace that would generate a class named `CaseIterable` now takes an
`Api` suffix.
