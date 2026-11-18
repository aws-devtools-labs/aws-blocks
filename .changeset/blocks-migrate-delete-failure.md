---
"@aws-blocks/blocks": patch
---

Migration rewrites `package.json` before removing unused wrappers. Failed deletions are reported with the wrapper path and error code; other unused wrappers are still removed. After correcting permissions, rerun migration with `--force` to remove leftovers.
