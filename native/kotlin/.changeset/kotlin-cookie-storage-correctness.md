---
"aws-blocks-kotlin": minor
---

Fix cookie storage losing, over-sending, and sharing cookies

Cookie matching and expiry now follow Ktor's `matches`/`fillDefaults`, so a cookie's `Domain`, `Path` and `Secure` attributes are honored and expired cookies are dropped instead of being sent indefinitely. On top of those, a cookie that arrives without a `Domain` is host-only and is no longer sent to subdomains of the host that set it, one that arrives without a `Path` applies to the directory of the request path rather than only to the endpoint that set it, and a `Max-Age=0` cookie is dropped on arrival so a sign-out takes effect immediately.

The jar is held in memory and persisted under a single key, and on JVM it is written through a temporary file and renamed, so a read that overlaps a write can no longer observe a partial write and silently discard a cookie. Every client in the process now shares one jar instead of opening several over the same storage. The JVM encryption key is staged and linked into place, so it can neither be created twice by concurrent first runs nor left empty by a process that stops midway, which would previously make every later write fail. On iOS the jar is updated in place instead of being deleted and re-added, so a write the keychain refuses no longer discards every stored cookie.

Storage that cannot be read is now distinguished from storage that is empty, so a temporary failure — a keychain locked while the device is — no longer presents as having no cookies and then overwrites the session that is still stored.

Storage reads and writes now suspend and run off the caller's thread rather than blocking it inside the request pipeline, except on iOS where keychain calls are short and synchronous. **`BlocksClient.clearCookies()` is now a `suspend` function** — call it from a coroutine. It also clears the whole cookie store rather than the current jar alone, so cookies written by an earlier version of the library are removed too; those older entries are not migrated, so a signed-in caller signs in once more after upgrading.
