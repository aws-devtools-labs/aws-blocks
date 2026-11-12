---
"aws-blocks-swift": minor
---

fix(swift): `OIDCClient.restore()` reads the server's session

**Source-breaking (pre-1.0):** `restore()` is now `@discardableResult func restore() async throws -> OIDCUser?`.
Call it with `try`. It reads `GET <base>/session` with the session cookie, plus the stored access
token when there is one. On 200 it emits `.signedIn` with the server's user and returns it. On 401
it clears stored tokens, emits `.signedOut` and returns `nil`. On 404 (the backend's `Auth` block
has no federated providers, so it serves no session route) it throws a `RawRouteError` that says
so. Any other failure is thrown and leaves the state and stored tokens unchanged.

Previously `restore()` reported signed out whenever no tokens were stored, even with a valid
session cookie, and built the user from the access token's `sub` claim instead of the server's
`userId`. It no longer emits `.loading`.
