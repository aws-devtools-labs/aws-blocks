---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): `blocks dev stop` right after a backend edit stops the dev server

A backend edit makes `tsx watch` restart the dev server. The old process removed its pidfile before the new one had booted, so a `blocks dev stop` in the first second or so after the edit found no record, printed "nothing to stop" and left the server running. The pidfile now stays through the restart, and the new process takes it over. A Ctrl-C or SIGHUP still removes it, and so does a `dev stop` once the port is free.
