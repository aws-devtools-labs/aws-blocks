---
"aws-blocks-swift": minor
---

fix(swift): parse and enforce the `Secure`, `Path` and `Expires`/`Max-Age` cookie attributes

`BlocksClient` now keeps each cookie's `Path`, `Secure` flag and expiry when it stores a
`Set-Cookie` response, and applies them when it attaches cookies to a request, following the same
rules as the Kotlin runtime. A cookie is sent only to the host that set it, only to request paths
under its `Path`, and, when `Secure`, only over `https`. A cookie without a `Path` applies to the
directory of the request path that set it. `Max-Age` takes precedence over `Expires`; a cookie
whose `Max-Age` is zero or less, or whose `Expires` has passed, is removed, and a stored cookie
stops being sent once its expiry arrives. A new cookie replaces the same-named cookies that would be
sent on that request. When several same-named cookies apply to a request, the one with the longest
`Path` is listed first in the `Cookie` header. Cookie reads and updates are applied one at a time, so
responses that arrive together leave the same cookies as if they had arrived in sequence.

Each Keychain item is now keyed by `host|path|name` and holds a JSON record of the cookie and its
attributes. Items written by earlier versions, keyed by `host|name` and holding the bare value,
are still read and sent as before (`Path=/`, not `Secure`, no expiry), so a signed-in session
survives the upgrade; the old item is replaced the next time the server sets that cookie. Items
written by this version are not readable by earlier versions.
