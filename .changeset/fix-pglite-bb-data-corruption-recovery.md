---
"@aws-blocks/bb-data": patch
---

fix(bb-data): recover from a PGlite `.bb-data` dir left half-written by an interrupted initdb (#98)

When `tsx watch` SIGTERMs/SIGKILLs the dev server while a local `Database` block is still running first-boot `initdb`, the PGlite data directory under `.bb-data/<fullId>` could be left non-empty but missing the `PG_VERSION`/`global/pg_control` markers a complete data dir has. On the next boot `new PGlite(dir)` aborted on the corrupt directory, the dev server's local-deploy phase rejected before `server.listen()` was ever reached, and the port never bound — the app stayed unreachable until `.bb-data` was deleted by hand.

`PGliteEngine` now detects an incompletely-initialized data directory before opening it and re-initializes the leaf directory instead of aborting, so a single interrupted boot is recoverable. A fully-initialized directory (even one with only a stale `postmaster.pid`) is left untouched, so real local data is preserved across restarts.
