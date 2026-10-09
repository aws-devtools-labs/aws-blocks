---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`relayOrigin()`'s `RelayConfigError` now keeps its name when it crosses the wire, and sign-in failures from an identity provider are proven never to carry the provider's raw text.

`relayOrigin()` rejects a bad `allowedRelayOrigins` entry with a `RelayConfigError`. That error is now branded as an intentional Building Block error (as `AuthOIDC`'s was), so `isBlocksError(e, 'RelayConfigError')` still matches on the client instead of the error collapsing to a nameless 500. Its message names only your own entry, so forwarding it leaks nothing.

The direct-OIDC engine already kept a failing provider's response body and a failing client-secret resolver's error off the wire, on a non-enumerable `cause`; a new test pins that for the code exchange, a 5xx token endpoint, a refresh grant and a secret resolver that throws with a role ARN, so a future change cannot quietly put that text back into a message a client reads.
