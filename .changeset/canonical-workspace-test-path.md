---
"@aws-blocks/create-blocks-app": patch
---

Fix a workspace scaffolding test assertion when the OS temporary directory is reached through a symlink, as on macOS. Scaffolding behavior is unchanged.
