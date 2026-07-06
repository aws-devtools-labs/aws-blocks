---
"@aws-blocks/bb-agent": patch
---

Lazy-load the Strands SDK in the Agent block so that importing `@aws-blocks/blocks` no longer eagerly loads `@strands-agents/sdk` and its non-optional `@modelcontextprotocol/sdk` / `@opentelemetry/api` peers. The umbrella package re-exports `Agent` statically, so a fresh scaffold that never uses an agent previously failed on `npm run dev` with `ERR_MODULE_NOT_FOUND` for those packages. The SDK is now imported on first agent execution instead of at module load, keeping it (and its ~10 MB transitive tree) off the load path of apps that don't instantiate an agent. No public API change.
