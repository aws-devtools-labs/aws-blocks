---
"@aws-blocks/hosting": patch
---

Reject deployment manifests whose compute placement cannot be honored, instead of silently synthesizing a regional Lambda for a non-edge resource marked as global.
