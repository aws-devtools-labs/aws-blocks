---
'@aws-blocks/core': patch
---

Reuse HTTP connections from the local dev server to the frontend server, avoiding excessive socket creation during repeated page loads. Release the connection pool when the dev server shuts down.
