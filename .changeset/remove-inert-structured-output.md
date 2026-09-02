---
"@aws-blocks/bb-agent": minor
"@aws-blocks/blocks": minor
---

refactor(bb-agent): remove inert `structuredOutput` field from `AgentConfig`

`AgentConfig` declared `structuredOutput?: z.ZodType`, but the field was never
implemented, read, or consumed anywhere — no JSDoc, no consumer, no docs, no
tests. It advertised a capability that does not exist, so setting it was a silent
no-op. The declaration is removed (along with its line in the generated
`API.md` report); no runtime behavior changes, because nothing ever read it.

Structured output remains a planned future LLM-BB feature, tracked separately.
This change only deletes the dead placeholder surface — it does not add or design
any real structured-output support.

This is a `minor` bump. Removing a property from an exported interface is a
breaking change to the public type surface, but every package here is pre-1.0,
where this repo's convention is that `minor` — not `major` — is the signal for a
breaking or behavior-altering change (see the `maxLlmCalls`/`maxToolIterations`
caps, which shipped as `minor` for exactly that reason). Practically the blast
radius is a compile error only: code that set `structuredOutput` was already
getting no-op behavior, so the error points at configuration that never did
anything and the fix is to delete it. The umbrella `@aws-blocks/blocks` gets the
same bump because it re-exports `AgentConfig`.
