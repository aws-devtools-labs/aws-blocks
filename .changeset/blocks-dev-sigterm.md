---
"@aws-blocks/blocks": patch
---

fix(blocks): a SIGTERM to the process group of `blocks dev` or `blocks sandbox` stops it cleanly

A supervisor, `timeout` or CI sends SIGTERM to the whole process group, so the child of `blocks dev` and `blocks sandbox` gets it directly. On a SIGTERM or SIGHUP, the CLI now sends `blocks dev`'s dev server one SIGTERM, which its idempotent cleanup takes without harm, and stops `tsx watch` only once the dev server is gone. Before, its immediate forward was a second SIGTERM to `tsx watch`, which then SIGKILLed the dev server before it stopped the frontend, and `next dev` or Vite kept running. Other commands still forward SIGTERM at once.
