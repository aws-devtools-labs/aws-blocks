---
"@aws-blocks/bb-agent": patch
"@aws-blocks/blocks": patch
---

feat(bb-agent): cap model and tool calls per turn to bound runaway cost

Adds two per-turn safety caps to `AgentConfig`, both defaulting to `20`:

- `maxLLMCalls` — the maximum number of model (Bedrock) invocations in a single
  turn. Model calls are the unit Bedrock bills for, so this is the most direct
  guard against an agent that loops its reason→act cycle indefinitely; because
  every tool round needs a model call, it transitively bounds tool loops too.
- `maxToolIterations` — the maximum number of tool calls in a single turn
  (parallel tool batches count each call).

When either cap is exceeded the turn is cancelled and the client receives an
`error` chunk (so `complete()` rejects) instead of `done`. Both caps are
enforced with in-loop Strands hooks, so they work identically on every compute
target with no cross-process signaling.

Behavior change: turns are now capped at 20 model calls and 20 tool calls by
default. This is generous for a single turn, but agents that legitimately reason
over many steps or chain many tools must raise `maxLLMCalls` /
`maxToolIterations`, or set a cap to `false` to disable it. The caps bound call
*count*, not tokens or wall-clock — pair them with a billing or CloudWatch alarm
on Bedrock spend for real cost protection.

This is a `patch` bump. Every package here is pre-1.0, where a `minor` bump is
this repo's signal for a breaking change; this change is not breaking — the new
default is a behavior change with an opt-out (raise the cap), and both options
are new and optional. The umbrella `@aws-blocks/blocks` gets the same bump
because it re-exports `AgentConfig`.
