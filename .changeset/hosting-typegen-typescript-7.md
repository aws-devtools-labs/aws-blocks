---
"@aws-blocks/hosting": patch
---

fix: secret/config typegen no longer crashes on TypeScript 7

TypeScript 7.0 ships no compiler API, so with it installed typegen crashed on every dev start and `hosting-typegen` run with `Cannot read properties of undefined (reading 'Latest')`. Typegen now checks that the installed `typescript` has the compiler API before parsing. On TypeScript 7 it skips with a warning that gives the side-by-side install the TypeScript team recommends: `npm i -D @typescript/native@npm:typescript@^7 typescript@npm:@typescript/typescript6@^6` keeps `tsc` on 7 and gives typegen the 6.0 API. An app that declares no `secret()`/`config()` no longer loads TypeScript for typegen at all, so it gets no warning. The optional `typescript` peer stays `>=5.3.0`, so TypeScript 7 apps install as before.
