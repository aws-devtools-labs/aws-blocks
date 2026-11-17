---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

Federated sign-in callbacks compare the returned `state`, and the ID token's `nonce`, in constant time, so response timing reveals nothing about a guessed value. A `state` or `nonce` of the wrong length or encoding is rejected with the usual `InvalidStateException` or `IdpErrorException`.
