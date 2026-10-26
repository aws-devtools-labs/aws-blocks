---
"aws-blocks-kotlin": patch
---

Check the result of the system random number generator on iOS

On iOS, generating the OIDC PKCE code verifier and sign-in `csrf` value now checks the status that `SecRandomCopyBytes` returns, and throws an `IllegalStateException` if the call fails instead of returning a buffer the call did not fill. On success, the values are generated the same way as before.
