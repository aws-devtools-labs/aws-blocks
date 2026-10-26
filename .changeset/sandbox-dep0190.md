---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): stop `npm run sandbox` printing a DEP0190 deprecation warning on Node 24

The sandbox started the local dev server by splitting its command on spaces and passing the pieces as separate args together with `shell: true`. Node 24 warns about that combination (DEP0190, args are concatenated rather than escaped). The command now goes to the shell as a single string, so the warning is gone and the dev server starts exactly as before.
