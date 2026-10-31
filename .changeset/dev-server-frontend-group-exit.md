---
"@aws-blocks/core": patch
---

fix(core): the dev server exits only after its whole frontend has

When it stops, the local dev server now waits, within its existing 1.5 s grace, for every process its frontend command started, not only the first, then SIGKILLs any that remain. `npx next dev` exits on SIGTERM before Next, which can go on writing `.next` after the dev server has exited.
