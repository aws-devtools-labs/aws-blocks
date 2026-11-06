---
"@aws-blocks/hosting": patch
---

fix: skip secret typegen cleanly on unsupported TypeScript versions

The optional `typescript` peer is now `>=5.3.0 <7`. TypeScript 7 has a different JS API, so typegen crashed on every dev start with `Cannot read properties of undefined (reading 'Latest')`. Typegen now checks the installed version and the compiler APIs it calls before parsing. If they don't match, it reports the installed version and the supported range and skips, the same way it handles a missing `typescript`.
