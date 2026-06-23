---
"@aws-blocks/core": minor
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/bb-agent": patch
---

Add `toAgentTools()` API for Building Blocks to expose their operations as agent tools. Core provides `buildAgentTools()` helper with filtering, overrides, and scope injection. KVStore exposes get, put, delete, and scan as agent tools with approval controls.
