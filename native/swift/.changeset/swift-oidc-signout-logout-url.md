---
"aws-blocks-swift": minor
---

fix(swift): `OIDCClient.signOut()` returns the identity provider's logout URL and reports failures

**Source-breaking (pre-1.0):** `signOut()` is now `@discardableResult func signOut() async throws -> URL?`.
Call it with `try`. It POSTs `<signOutPath>?format=json` and returns the provider's logout URL, or
`nil` when there is none, or when a custom block's route answers with an empty 2xx body. Open that
URL in the browser, such as with `UIApplication.shared.open`, to end the provider's own session; the
client doesn't open it. Don't open it in a sign-in sheet: the provider's logout redirects to the
backend's post-sign-out page, never to `relayTo`, so a `WebAuthenticationSessionLauncher` sheet stays
open until the user closes it and ends in `OIDCError.cancelled`. When the server cleared the cookie but could not remove its session, it
signs out locally and throws an `ApiError` named `SignOutIncompleteException` (HTTP 503). Any
other failure (a `TransportError`, a `CancellationError`, an `ApiError` with another status) also
signs out locally before it throws: the client clears the block's stored tokens, removes the
block's session cookie (and no other block's), and emits `.signedOut`. The client knows that cookie
by the `oidc/client` descriptor's `sessionCookieName`; from a backend that doesn't send it, by the
cookie names the block's sign-in response set. A sign-out on a closed client throws
`ClientClosedError` and changes nothing.

Previously the server's empty 204 response failed to parse, the failure was ignored, and the logout
URL was dropped. The body is now `{}`: the server ends the session from its cookie and never read
the `refreshToken` the client used to send, which also means sign-out doesn't revoke bearer tokens.
