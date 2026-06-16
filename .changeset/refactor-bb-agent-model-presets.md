---
"@aws-blocks/bb-agent": minor
---

refactor(bb-agent): rename model presets — drop DEFAULT/BUDGET/MICRO, add SMART/BALANCED, use global. prefix

- `BALANCED` (Claude Sonnet 4.6): recommended default for most workloads
- `SMART` (Claude Opus 4.8): highest capability for hardest tasks
- `FAST` (Claude Haiku 4.5): lowest latency

All presets use `global.` inference profiles for region-agnostic deployment.

BREAKING: `BedrockModels.DEFAULT`, `BedrockModels.BUDGET`, `BedrockModels.MICRO` removed.
Use `BedrockModels.BALANCED` as the default.
