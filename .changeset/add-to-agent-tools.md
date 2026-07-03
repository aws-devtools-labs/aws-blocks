---
"@aws-blocks/core": minor
"@aws-blocks/bb-kv-store": minor
"@aws-blocks/bb-agent": patch
---

Add `toAgentTools()` API for Building Blocks to expose their operations as agent tools. Core provides `buildAgentTools()` helper with filtering, overrides, and scope injection. KVStore exposes get, put, delete, and scan as agent tools with approval controls.

Building Blocks that can hold per-user data declare `requiresScope` (via the new `BuildAgentToolsConfig`); `buildAgentTools()` then throws at construction unless the caller passes `scope` or `unscoped: true`, so an accidental unscoped spread can't quietly expose every user's data. KVStore opts into this. `MethodOverrides.schema` is now typed as `StandardSchemaV1` (core depends only on the types-only `@standard-schema/spec`, never on a concrete validation library).

Fields injected server-side by `scope` or `fixed` are stripped from the JSON Schema parameters the model sees, so the model never receives a parameter it can't control. Registry methods can declare `scopeSafe: false` (e.g. a `scan` that lists the whole store); `buildAgentTools()` throws if such a method is exposed under `scope`, preventing a scoped store from leaking data across users. KVStore marks `scan` accordingly.
