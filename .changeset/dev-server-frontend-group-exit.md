---
"@aws-blocks/core": patch
---

fix(core): the dev server exits only after its whole frontend has

When it stops, the local dev server now waits, within its existing 1.5 s grace, for every process its frontend command started, not only the first, then SIGKILLs any that remain. `npx next dev` exits on SIGTERM before Next, which can go on writing `.next` after the dev server has exited.

A second Ctrl-C or SIGTERM during that wait no longer ends the dev server before its frontend has stopped. A Ctrl-C, or a SIGTERM to the process group, reaches the dev server twice: directly, and again as `tsx watch` relays it. On the second one, tsx ended the dev server, because the dev server had already removed its own signal listeners.
