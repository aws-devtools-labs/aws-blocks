---
'@aws-blocks/data-common': patch
---

Closing local engines when the process exits now runs every registered close even if one throws synchronously, and the throw no longer escapes the `beforeExit` handler.
