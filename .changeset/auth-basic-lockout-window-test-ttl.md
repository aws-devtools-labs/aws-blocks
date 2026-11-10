---
"@aws-blocks/bb-auth-basic": patch
---

Stabilize the AuthBasic test that checks a failure older than `windowSeconds` restarts the sign-in failure count. It used 1-second windows, so the counter row it reads back expired at the next whole second and the test failed whenever the clock crossed one between the failed sign-in and the read. It now uses 60-second windows.
