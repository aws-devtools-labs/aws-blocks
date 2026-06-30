---
"@aws-blocks/bb-agent": minor
---

refactor(bb-agent): capability-based model presets with global inference profiles

New presets:
- `BALANCED` (Claude Sonnet 4.6): recommended default for most workloads
- `SMART` (Claude Opus 4.8): highest capability for hardest tasks
- `FAST` (Claude Haiku 4.5): lowest latency

All presets use `global.` inference profiles for region-agnostic deployment.

Deprecated (non-removing): `DEFAULT` resolves to `BALANCED`, `BUDGET` and `MICRO` resolve to `FAST`. Note this changes the underlying model for existing callers — `DEFAULT` moves from Opus to Sonnet, and `BUDGET`/`MICRO` move from Amazon Nova Pro/Lite to Claude Haiku, so cost and latency profiles differ. The symbols still resolve (no type break), but migrate to `BALANCED`/`FAST` (or a region-scoped profile) explicitly to pin the model you want.
