---
"@aws-blocks/hosting": patch
---

fix(hosting): keep `HostingError.cause` out of serialized output

`HostingError` now passes its optional cause to the native `Error` constructor, so `cause` is a non-enumerable property. `JSON.stringify` and object spread of a `HostingError` no longer include the wrapped error (for example AWS SDK `$metadata`). `error.cause` still returns the original error.
