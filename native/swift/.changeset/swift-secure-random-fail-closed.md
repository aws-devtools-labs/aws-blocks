---
"aws-blocks-swift": patch
---

fix(swift): check the result of the system random number generator in `OIDCClient`

`OIDCClient.generateVerifier()` and `OIDCClient.generateNonce()`, which also produce the sign-in `csrf` value, now check the status that `SecRandomCopyBytes` returns and stop the process with `fatalError` if the call fails, as the standard library's `SystemRandomNumberGenerator` does, instead of returning a buffer the call did not fill. Their signatures are unchanged, and on success they return values generated the same way as before.
