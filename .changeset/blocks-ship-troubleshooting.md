---
"@aws-blocks/blocks": patch
---

fix: publish `TROUBLESHOOTING.md` at the package root

The package README links to `./TROUBLESHOOTING.md`, but the file only shipped under `docs/`, so the link was dead on npm and in `node_modules/@aws-blocks/blocks/`. It now ships at the package root too.
