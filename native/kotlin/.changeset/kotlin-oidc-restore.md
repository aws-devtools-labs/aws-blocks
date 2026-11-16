---
"aws-blocks-kotlin": minor
---

Add `OidcClient.restore()`, which reads the backend's session for the client's cookie (`GET` the
descriptor's `sessionPath`, or `<callback directory>/session`). It returns the signed-in user and
sets `authState` to signed in, or returns `null` and sets it to signed out when there is no
session. Any other failure status throws `OidcSessionException`, carrying the `statusCode` and the
backend's `errorName`, and leaves `authState` unchanged. A 404 means the backend serves no session
route, as for an `Auth` block with no federated providers, and a 200 that holds no user reports
status 200. A sign-in or sign-out that finishes while `restore` is waiting keeps the state it set.
Call it on launch: `authState` stays `Loading` until `restore`, `signIn` or `signOut` settles it.
