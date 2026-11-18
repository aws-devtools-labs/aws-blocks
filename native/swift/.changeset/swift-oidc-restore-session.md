---
"aws-blocks-swift": minor
---

fix(swift): `OIDCClient.restore()` reads the server's session

**Source-breaking (pre-1.0):** `restore()` is now `@discardableResult func restore() async throws -> OIDCUser?`.
Call it with `try`. It reads `GET <sessionPath>` with the session cookie, plus the stored access
token when there is one that hasn't expired. `sessionPath` is the descriptor's `sessionPath`, or
`session` beside the block's callback route (`/aws-blocks/auth/session` by default) when the
descriptor names none. On 200 it emits `.signedIn` with the server's user and returns it. On 401 it
clears stored tokens, emits `.signedOut` and returns `nil`. On 404 (the backend's `Auth` block has
no federated providers, so it serves no session route) it throws an `ApiError` with `status` 404
that says so. A response without a `user` throws `TransferableError.invalidDescriptor`, as an
exchange response's incomplete user does. Any other failure (an `ApiError`, a `TransportError`, a
`CancellationError` or a `ClientClosedError`) is thrown and leaves the state and stored tokens
unchanged. A custom block whose method returns an `oidc/client` must now serve that session route
for `restore()` to work.

Previously `restore()` reported signed out whenever no tokens were stored, even with a valid
session cookie, and built the user from the access token's `sub` claim instead of the server's
`userId`. It no longer emits `.loading`.
