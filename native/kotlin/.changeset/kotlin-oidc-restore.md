---
"aws-blocks-kotlin": minor
---

Add `OidcClient.restore()`, which reads the backend's session for the client's cookie (`GET` the
descriptor's `sessionPath`, or `<callback directory>/session`). It returns the signed-in user and
sets `authState` to signed in, or returns `null` and sets it to signed out when there is no
session (a 401). A refusal the backend explains throws `ApiException` with its `status` and
`name`; a request that never completes, a refusal with no explanation, a 404 (the backend serves
no session route, as for an `Auth` block with no federated providers) or a 2xx body with no user
throws `TransportException`. Every failure leaves `authState` unchanged. A sign-in or sign-out that
finishes while `restore` is waiting keeps the state it set. Call it on launch: `authState` stays
`Loading` until `restore`, `signIn` or `signOut` settles it.
