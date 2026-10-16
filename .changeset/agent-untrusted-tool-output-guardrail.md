---
"@aws-blocks/bb-agent": minor
"@aws-blocks/bb-knowledge-base": patch
---

feat(bb-agent): mark tool output as untrusted, attach a Bedrock guardrail, and stop silently ignoring `guardrails`

Tools that return content you don't control (knowledge-base chunks, fetched web pages, user uploads) put that text in the model's context next to real instructions, where it can try to steer the agent into misusing its other tools (indirect prompt injection). Three opt-in controls:

- **`untrustedOutput: true` on a tool.** The tool's result is wrapped in an `<untrusted-data>` block whose delimiter carries a random per-session id, and the agent's system prompt tells the model that content inside it is data, never instructions. Content can't close the block early: any occurrence of the session id inside it is neutralized. Tools without the flag are unchanged.
- **`guardrail: { identifier, version, trace? }` on a Bedrock `ModelConfig`.** Attaches an existing Amazon Bedrock guardrail to every model call. The deployed agent is granted `bedrock:ApplyGuardrail` on that guardrail only (an id is expanded to the stack's guardrail ARN; an ARN is used as-is). Setting it on a non-Bedrock provider throws `InvalidModelConfig` instead of being ignored.
- **`ModelConfig.guardrails` is deprecated.** No provider ever applied it, so it gave no protection. It still type-checks, and the agent now logs a warning when it is set.

The Agent and KnowledgeBase READMEs now document the trust boundary: mark retrieval tools `untrustedOutput`, put `needsApproval` on side-effecting tools, and set knowledge-base filters from the authenticated caller rather than from request or tool input, since a filter is a query scope, not an access control.
