---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`relayOrigin()`'s `RelayConfigError` keeps its name when it crosses the wire, and sign-in failures from an identity provider never carry the provider's raw text.

`relayOrigin()` rejects a bad `allowedRelayOrigins` entry with a `RelayConfigError`. That error is branded as an intentional Building Block error (as `AuthOIDC`'s was), so `isBlocksError(e, 'RelayConfigError')` matches on the client instead of the error collapsing to a nameless 500. Its message names only your own entry, so forwarding it leaks nothing.

The engine that verifies a `store: 'builtin'` block's providers keeps a failing provider's response body and a failing client-secret resolver's error off the wire, on a non-enumerable `cause`; tests cover the code exchange, a 5xx token endpoint, a refresh grant and a secret resolver that throws with a role ARN.
