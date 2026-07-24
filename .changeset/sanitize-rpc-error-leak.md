---
"@aws-blocks/core": patch
---

Stop leaking raw backend exception details in RPC error responses. `errorResponseFromCatch` now only forwards `ApiError` instances verbatim; every other throw (driver/SDK exceptions, unexpected bugs) collapses to a generic `500` / `"Internal error"` on the wire, with the full error still logged server-side. This prevents internal exception class names and raw driver messages from reaching clients.
