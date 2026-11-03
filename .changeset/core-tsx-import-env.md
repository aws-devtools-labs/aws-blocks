---
"@aws-blocks/core": patch
---

fix(core): let a launcher choose the `tsx` loader for deploy client generation

The client-generation step of `deploy()` and `startSandbox()` loads the backend with `node --import tsx`, which Node resolves from the app's directory. `BLOCKS_TSX_IMPORT`, when set, replaces `tsx` with another specifier, such as the file URL of a `tsx` loader the app does not install itself. Without the variable nothing changes.
