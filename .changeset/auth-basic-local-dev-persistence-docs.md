---
"@aws-blocks/bb-auth-basic": patch
---

The `AuthBasic` docs now describe local development correctly. Users, verification codes, sign-out revocations and lockout counters are saved under `.bb-data/` in the working directory, and so is the JWT signing secret. They survive a dev server restart, so signed-up users can still sign in and existing sessions stay valid. The docs previously said users were lost and sessions were invalidated on restart. Run `rm -rf .bb-data` to start fresh.
