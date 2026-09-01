---
"@aws-blocks/bb-agent": minor
"@aws-blocks/blocks": minor
---

feat(bb-agent): cap model and tool calls per turn to bound runaway cost

Adds two per-turn safety caps to `AgentConfig`, both defaulting to `20`:

- `maxLlmCalls` — the maximum number of model (Bedrock) invocations in a single
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
over many steps or chain many tools must raise `maxLlmCalls` /
`maxToolIterations`, or set a cap to `false` to disable it. The caps bound call
*count*, not tokens or wall-clock — pair them with a billing or CloudWatch alarm
on Bedrock spend for real cost protection.

This is a `minor` bump. Every package here is pre-1.0, where `minor` is this
repo's signal for a change that can alter existing behavior. The two options are
new and optional and there's an opt-out (raise the cap, or set it to `false`),
but the new default changes the runtime behavior of every existing agent — a
turn that legitimately exceeds 20 model or tool calls is now cut off unless the
customer opts out — so it ships as `minor` rather than `patch` to surface that
clearly. The counts cover a whole logical turn: they live in the agent's
persisted session state, and the per-turn reset is keyed on a turn id applied
lazily (the session snapshot is restored inside `stream()`, so an up-front reset
would be overwritten and the budget would leak into the next turn), so a turn
paused on a human-in-the-loop interrupt keeps its budget across `resume()` while
a new message always starts a fresh one. A cap value must be a positive integer
or `false`; anything else throws `InvalidModelConfigException`. The umbrella
`@aws-blocks/blocks` gets the same bump because it re-exports `AgentConfig`.
