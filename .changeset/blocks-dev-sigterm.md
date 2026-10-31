---
"@aws-blocks/blocks": patch
---

fix(blocks): a SIGTERM to the process group of `blocks dev` or `blocks sandbox` stops it cleanly

A supervisor, `timeout` or CI sends SIGTERM to the whole process group, so the child of `blocks dev` and `blocks sandbox` gets it directly. The CLI now treats SIGTERM and SIGHUP for these commands as it treats SIGINT: it waits, and forwards one SIGTERM only if the child is still running after 10 s. Before, its immediate forward was a second SIGTERM, on which `tsx watch` SIGKILLed the dev server before it stopped the frontend, and `next dev` or Vite kept running. Other commands still forward SIGTERM at once.
