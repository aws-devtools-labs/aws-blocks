---
'@aws-blocks/bb-knowledge-base': minor
'@aws-blocks/blocks': minor
---

Add `KnowledgeBase.asAgentTool()`, which returns a search tool for an Agent's `tools` callback. The model supplies only the query; a required `filter` callback derives the metadata filter from the per-call tool context (set from the authenticated session), and the tool is marked `untrustedOutput: true` so retrieved text reaches the model as data. A `filter` result other than `undefined` must narrow the search (`null`, `{}` or a missing `equals` fails the call), and `maxResults` is checked when the tool is defined. The umbrella package re-exports the new `KnowledgeBaseAgentTool`, `KnowledgeBaseAgentToolOptions` and `KnowledgeBaseAgentToolResult` types.
