---
"@aws-blocks/create-blocks-app": patch
---

New apps and apps that add AWS Blocks to an existing project now git-ignore `.blocks/*.lock*` and `.blocks/*.tmp`. These are the lock, lock-record and temp files AWS Blocks creates next to `.blocks/config.json` while it updates it. A command killed mid-update can leave them behind, and because `.blocks/` is committed they could otherwise end up in a commit. `.blocks/config.json` itself stays tracked. Adding AWS Blocks to an existing project adds each pattern only if the `.gitignore` doesn't list it already.
