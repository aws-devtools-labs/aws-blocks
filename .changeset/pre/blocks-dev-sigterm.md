---
"aws-cdk-blocks": patch
---

fix(blocks): a SIGTERM to the process group of `npm run dev` or `npm run sandbox` stops it cleanly

A supervisor, `timeout` or CI sends SIGTERM to the whole process group, so the child of `npm run dev` and `npm run sandbox` gets it directly. On a SIGTERM or SIGHUP, the CLI now sends `npm run dev`'s dev server one SIGTERM, which its idempotent cleanup takes without harm, and stops `tsx watch` only once the dev server is gone. Before, its immediate forward was a second SIGTERM to `tsx watch`, which then SIGKILLed the dev server before it stopped the frontend, and `next dev` or Vite kept running. Other commands still forward SIGTERM at once.
