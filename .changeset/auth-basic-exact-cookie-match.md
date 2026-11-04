---
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

`AuthBasic` now reads its session cookie by exact name. Previously a cookie whose name merely ended with the session cookie's name (for example `xauth_<id>`, set by another app on a shared parent domain) could supply or shadow the session value, and a `.` in the scope id matched any character.

The match is now anchored to a cookie boundary and the scope id is matched literally, the same way `AuthCognito` reads its cookie. Apps need no changes.
