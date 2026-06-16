---
"@aws-blocks/bb-agent": minor
---

refactor(bb-agent): rename model presets — drop DEFAULT, add SMART/BALANCED, replace Nova with Llama

- `BALANCED` (Sonnet 4.6): recommended default for most workloads
- `SMART` (Opus 4.8): highest capability for hardest tasks
- `FAST` (Haiku 4.5): lowest latency
- `BUDGET` (Llama 4 Scout 17B): low cost with tool support
- `MICRO` (Llama 3.2 3B): ultra-cheap for simple tasks

BREAKING: `BedrockModels.DEFAULT` removed — use `BedrockModels.BALANCED` instead.
