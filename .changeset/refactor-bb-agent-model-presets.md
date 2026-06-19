---
"@aws-blocks/bb-agent": minor
---

refactor(bb-agent): capability-based model presets with global inference profiles

New presets:
- `BALANCED` (Claude Sonnet 4.6): recommended default for most workloads
- `SMART` (Claude Opus 4.8): highest capability for hardest tasks
- `FAST` (Claude Haiku 4.5): lowest latency

All presets use `global.` inference profiles for region-agnostic deployment.

Deprecated (non-breaking): `DEFAULT`, `BUDGET`, `MICRO` still work but resolve to `BALANCED`.
