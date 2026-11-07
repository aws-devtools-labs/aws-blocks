---
'@aws-blocks/core': patch
---

Browser builds with Vite no longer warn `Module "node:fs" has been externalized for browser compatibility` when importing the Blocks client. The client still reads `.blocks-sandbox/config.json` under Node.js as before.
