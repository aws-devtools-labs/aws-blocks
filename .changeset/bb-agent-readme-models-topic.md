---
"@aws-blocks/bb-agent": patch
---

docs: move model presets and Bedrock access into `MODELS.md`; fix two stale README statements

- The Bedrock and Ollama presets, Bedrock Guardrails, health checks, API key management, AWS credentials (Bedrock) and Bedrock via Mantle sections move unchanged from the README into `MODELS.md`, which the package already lists in `files`. The README keeps the `model` option table and examples, links to each moved section, and keeps the data-residency caveat for the presets, the one-time Anthropic and AWS Marketplace steps, what a health check does not prove, and the Mantle permissions locally and deployed, `apiKey` precedence and Chat Completions-only model support.
- The React example for the deprecated `useChat` now points to the `createChat` React example and keeps only what differs with `useChat`.
- The README no longer recommends the deprecated `useChat` for subscribe-before-send ordering; `createChat` handles it.
- The `AgentErrors.InvalidModelConfig` row now also lists `trustable` with `interrupt` on a tool and `guardrail` on a provider other than `bedrock`.
