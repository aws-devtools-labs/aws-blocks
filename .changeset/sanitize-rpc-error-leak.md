---
"@aws-blocks/core": patch
---

Stop leaking raw backend exception details in RPC error responses without dropping Building Block error names.

`errorResponseFromCatch` now sorts a caught throw into three cases: an `ApiError` crosses the wire verbatim (status, `name`, `retriable`); a Building Block error thrown via `blocksError()` forwards its BB `name` in `data.name` but drops the raw message (a generic `500` / `"Internal error"`), so `isBlocksError()` keeps matching on the client per D-003; and everything else — a driver/SDK exception, a bare `Error`, or a non-`Error` throw — collapses to a nameless generic `500`. The full error is still logged server-side in every case.

`blocksError()` now stamps a non-enumerable brand on the errors it produces, and the serializer keys the name-forwarding decision on that brand rather than on `.name !== 'Error'`. This is the unambiguous "intentional BB error" signal: a raw driver exception whose class name happens to be non-generic (`PostgresError`, `DynamoDBServiceException`) is not branded, so its class name still never reaches the client.
