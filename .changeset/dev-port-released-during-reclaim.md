---
'@aws-blocks/core': patch
---

`cdk-blocks dev` no longer fails with "port … is in use (its owner could not be found)" when the process holding the port releases it while the dev server checks it, for example a second dev server started at the same moment that exits. The dev server now checks the port again before reporting it in use.
