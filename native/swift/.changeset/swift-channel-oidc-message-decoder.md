---
"aws-blocks-swift": patch
---

A realtime channel returned by an operation now decodes messages that hold an OIDC client

When an operation returned a channel directly and its messages held an `OIDCClient` (for example `RealtimeChannel<SignInOption>`, where `SignInOption` has a `client` field), the generated client decoded each message with a plain `JSONDecoder`. Every message failed to decode with `Decoding an OIDCClient needs the BlocksClient that fetched it`. Such messages now decode with `BlocksClient.makeDecoder()`, which carries the client, as a result that holds an OIDC client already did. A channel inside a model was not affected.
