---
'@aws-blocks/hosting': patch
---

The hidden value prompt of the secret and config CLI (`hosting-secret set KEY`, `runValueCli`) rejects with the new `ValueCliInterruptedError` on Ctrl-C or Ctrl-D, before any store call, instead of never settling: Node then exited 13 with an "unsettled top-level await" warning.
