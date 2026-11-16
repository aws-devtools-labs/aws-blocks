---
"aws-blocks-kotlin": minor
---

One error taxonomy shared with the Swift and Dart clients

Errors now split by what went wrong rather than by where the failure surfaced, so a catch site can tell "the server considered this request and said no" from "the request never produced an answer".

**`ApiException`** is the first of those. It carries `status`, `name` and the new `retriable`, replacing `code` and `data`. `status` is the HTTP status the server rejected with, with JSON-RPC's reserved codes reported as 500. `retriable` says whether the same action can be retried without restarting the wider flow, which matters for a multi-step auth challenge: a mistyped MFA code can be re-entered against the same session, an expired one cannot.

Match on `name`, not on `status`: a named error the backend threw without a status arrives as a 500 with its name intact, so `status == 500` does not mean "unknown server fault". `Throwable.isBlocksError(name)` is unchanged and is still the way to do it. The client now also fills in the name for a reserved JSON-RPC code the server sent without one, so a missing method is `isBlocksError("MethodNotFound")` rather than an anonymous 500.

`data` is gone. The only things the backend ever put in it were `name` and `retriable`, and both are now properties, so the `(e.data as Map)["name"]` hand-cast is no longer needed.

**`TransportException`** replaces `NetworkException` and covers every case where no usable JSON-RPC result came back: a connection that failed before any response (`statusCode` is null), a response carrying no JSON-RPC envelope such as a gateway's own error page, a response whose body could not be read, and an envelope that arrived without a `result`. A connection failure used to escape as a Ktor exception; no Ktor type crosses the public surface now, and a cancelled coroutine is no longer reported as a transport failure.

**`FileTransferException`** replaces `TransferableIOException` for a failed upload or download, and carries `statusCode` as a property rather than only inside the message text. It is no longer a `TransferableException`: that type now means only that a transferable descriptor could not be hydrated, which is a different failure from a transfer that broke after the handle existed.

**`ClientClosedException`** is thrown by a request made through a closed `Blocks`, including an OIDC call, where the base `BlocksException` was thrown before. **`RealtimeChannelClosedException`** replaces `IllegalStateException` when subscribing to a closed channel — a channel can close on its own when the connection drops, so that is a condition to catch rather than a programming mistake.

Every new type still extends `BlocksException`, so a `catch (e: BlocksException)` keeps working.
