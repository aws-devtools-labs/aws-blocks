---
'@aws-blocks/core': patch
---

`cdk-blocks dev` no longer fails with "port … is in use (its owner could not be found)" when the process holding the port releases it while the dev server checks it, for example a second dev server started at the same moment that exits. When the port probe finds the port bound but `lsof` (or `netstat` on Windows) finds no listener, the dev server now waits up to 1 second for the port to be released and checks again. A port free by then is used without stopping anything; a port still bound is looked up once more, and its holder is reported as before.
