---
"aws-blocks-swift": minor
---

fix(swift): parse and enforce the `Secure`, `Path` and `Expires`/`Max-Age` cookie attributes

`BlocksClient` now keeps each cookie's `Path`, `Secure` flag and expiry when it stores a
`Set-Cookie` response, and applies them when it attaches cookies to a request, following the same
rules as the Kotlin runtime. A cookie is sent only to the host that set it, only to request paths
under its `Path`, and, when `Secure`, only over `https`. A cookie without a `Path` applies to the
directory of the request path that set it. When `URLSession` follows a redirect, cookies are scoped
to the URL of the response that set them. `Max-Age` takes precedence over `Expires`; a cookie
whose `Max-Age` is zero or less, or whose `Expires` has passed, is removed, and a stored cookie
stops being sent once its expiry arrives. A new cookie replaces the same-named cookies that would be
sent on that request. When several same-named cookies apply to a request, the one with the longest
`Path` is listed first in the `Cookie` header. Cookie reads and updates are applied one at a time, so
responses that arrive together leave the same cookies as if they had arrived in sequence.

Each Keychain item is now keyed by `host|path|name` and holds a JSON record of the cookie and its
attributes. Cookies stored by 0.1.x, keyed by `host|name` and holding the bare value, are kept:
they are read as `Path=/` and `Secure` for the host that set them, the attributes the Auth block
sets its session cookies with, and are replaced in the current format on the next `Set-Cookie` of
the same name from that host. A session only used over plain `http` (for example, local
development) is no longer sent, so those users sign in again. Items written by this version are not
readable by earlier versions.
