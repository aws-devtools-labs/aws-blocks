---
"@aws-blocks/bb-data": patch
---

Recover incomplete local PGlite data directories before opening the database so an interrupted first boot does not permanently prevent local dev startup.
