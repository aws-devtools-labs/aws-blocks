---
"aws-blocks-swift": patch
---

fix(swift): name the missing field when an authorize-params response is incomplete

When the server's authorize-params response lacks `authorizeUrl`, `clientId`, `scopes` or `state`,
`OIDCClient.signIn` throws `OIDCError.callbackError` naming that field. The message used to embed
the whole response, including the signed state and the nonce.
