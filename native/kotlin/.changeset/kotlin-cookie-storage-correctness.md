---
"aws-blocks-kotlin": minor
---

Fix cookie storage losing, over-sending, and sharing cookies

Cookie matching and expiry now follow Ktor's `matches`/`fillDefaults`, so a cookie's `Domain`, `Path` and `Secure` attributes are honored and expired cookies are dropped instead of being sent indefinitely. The jar is held in memory and persisted under a single key, and on JVM it is written through a temporary file and renamed, so a read that overlaps a write can no longer observe a partial write and silently discard a cookie. Every client in the process now shares one jar instead of opening several over the same storage, and the JVM encryption key can no longer be created twice by concurrent first runs.

Storage reads and writes now suspend and run off the caller's thread rather than blocking it inside the request pipeline. **`BlocksClient.clearCookies()` is now a `suspend` function** — call it from a coroutine.
