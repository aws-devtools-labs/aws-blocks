# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- Agent — the AI agent that answers questions and calls at least one tool. Expect `new Agent(...)` configured with `tools`, and a real turn via `agent.stream(question, ...)` (then `agent.getConversation(...)` to surface tool use).
- KnowledgeBase — retrieval over the self-seeded `./knowledge` folder; the answer must repeat a fact that lives ONLY in the KB. Expect `kb.retrieve(query, { maxResults })`, typically called from inside an agent tool.
