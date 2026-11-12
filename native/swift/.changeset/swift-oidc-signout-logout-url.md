---
"aws-blocks-swift": minor
---

fix(swift): `OIDCClient.signOut()` returns the identity provider's logout URL and reports failures

**Source-breaking (pre-1.0):** `signOut()` is now `@discardableResult func signOut() async throws -> URL?`.
Call it with `try`. It POSTs `<signOutPath>?format=json` and returns the provider's logout URL, or
`nil` when there is none. Open that URL with your launcher to end the provider's own session; the
client doesn't open it. When the server cleared the cookie but could not remove its session, it
signs out locally and throws a `RawRouteError` named `SignOutIncompleteException`. Any other failure
clears the stored tokens and throws, with the state unchanged.

Previously the server's empty 204 response failed to parse, the failure was ignored, and the logout
URL was dropped. The body is now `{}` when no refresh token is stored, instead of an empty
`refreshToken`.
