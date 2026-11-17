---
"aws-blocks-kotlin": minor
---

One error taxonomy shared with the Swift and Dart clients. Every new type extends `BlocksException`.

Breaking:

- `ApiException` drops `code` and `data` for `status`, `name` and `retriable`.
- `TransportException` replaces `NetworkException`.
- `FileTransferException` replaces `TransferableIOException` and carries `statusCode`. It is no longer a `TransferableException`.
- `RealtimeChannelClosedException` replaces the `IllegalStateException` thrown when subscribing to a closed channel.
- A request through a closed `Blocks`, including an OIDC call, throws `ClientClosedException` instead of the base `BlocksException`.
- Ktor and kotlinx exceptions no longer cross the public surface. A failed OIDC request or an unreadable response during sign-in is an `OidcExchangeException` or `OidcCallbackException`, with a fixed message and the original as `cause`. A failed `signOut` request is a `TransportException`.
- A generated method whose result type is non-null throws `TransportException` for a `null` result.

New types: `TransportException`, `ClientClosedException`, `FileTransferException`, `RealtimeException`, `RealtimeChannelClosedException` and `RealtimeConnectionException`.

Also: a JSON-RPC envelope (`"jsonrpc": "2.0"`) with no `result` is a successful call with no value, so a void method succeeds; any other 2xx body is a `TransportException`. A gateway's `{"message": ...}` body is the `TransportException` message, a refused OIDC exchange or authorize-params request carries the backend's `name` and `status` as an `ApiException` `cause`, `OidcCallbackException` gains a `cause`, and `retriable` is true only for a JSON boolean.
