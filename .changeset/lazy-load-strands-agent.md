---
"@aws-blocks/bb-agent": patch
---

Lazy-load the Strands SDK in the Agent block so that importing `@aws-blocks/blocks` no longer eagerly loads `@strands-agents/sdk` and its non-optional `@modelcontextprotocol/sdk` / `@opentelemetry/api` peers.

The `@aws-blocks/blocks` umbrella re-exports `Agent` statically, so a fresh scaffold that never instantiates an agent previously failed on the first `npm run dev` with `ERR_MODULE_NOT_FOUND` for those packages. The Strands runtime is now imported on first agent execution (via a cached dynamic `import()`), so it stays off the module **load path** of apps that don't use an agent — those apps run without the packages installed.

Scope / follow-up: this removes the packages from the *load path*, not from the *install set*. Apps that actually use an Agent block still need `@strands-agents/sdk`'s non-optional peers (`@modelcontextprotocol/sdk`, `@opentelemetry/api`) installed, because Strands imports them when it loads on first agent execution and npm does not auto-install peers of transitive dependencies. Those are supplied to agent-using apps by the Agent scaffold template (and documented for manual installs) rather than promoted to `dependencies` here, which would pull Strands' ~10 MB transitive tree into every app. No public API change.
