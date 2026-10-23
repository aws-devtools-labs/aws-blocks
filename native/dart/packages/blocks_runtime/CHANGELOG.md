## Unreleased

- Add `validateTransferableDescriptor`, which checks a descriptor's `__blocks`
  tag against the tag the spec declared and returns it.
- Add `UnknownTransferable`, returned for a direct method result whose
  transferable tag has no known runtime binding, instead of untyped `dynamic`.
- **Breaking:** `SessionStore` gains `cookieHeaderFor(Uri)` and an optional
  `requestUri` argument on `setCookies`; custom implementations must add both.
  `InMemorySessionStore` and `PersistentSessionStore` now parse and enforce the
  `Secure`, `Path` and `Expires`/`Max-Age` cookie attributes, matching the
  Kotlin runtime: a cookie is sent only to the host that set it, only to
  request paths under its `Path`, and, when `Secure`, only over `https`/`wss`.
  `Max-Age` takes precedence over `Expires`, and a cookie whose `Max-Age` is
  zero or less, or whose `Expires` has passed, is removed. Cookies are keyed by
  host, path and name rather than by name alone, and a new cookie replaces the
  same-named cookies that would be sent on that request, as in the Kotlin
  runtime. `cookieHeaderFor` lists the cookie with the longest `Path` first
  when several same-named cookies apply. `BlocksClient` and `OidcClient` pass
  the request URL to `cookieHeaderFor`, and to `setCookies` the URL of the
  response, which is the last redirect target when the HTTP client followed
  redirects. `cookieHeader` still returns every unexpired cookie.
- `PersistentSessionStore` now stores a JSON list of cookie records. The
  name → value map written by earlier versions is still read: those cookies
  keep `Path=/`, no `Secure` and no expiry, as before, until the server sets
  them again.

## 0.1.4

- Send the `aws-blocks-dart` user-agent token on outbound runtime requests

## 0.1.3

- Minor bug fixes and improvements

## 0.1.2

- Bump dependencies and minimal Dart version

## 0.1.1

- Minor bug fixes and improvements

## 0.1.0

- Initial release
