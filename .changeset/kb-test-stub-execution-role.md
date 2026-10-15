---
"@aws-blocks/bb-knowledge-base": patch
"@aws-blocks/blocks": patch
---

Test-only: the `bb-knowledge-base` CDK test stub no longer mimics the default-compute `handler` accessor; it grants through the shared `executionRole` like the Building Block does. No runtime or public API change.
