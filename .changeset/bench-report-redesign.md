---
---

feat(bench): redesign agent-bench PR-vs-`main` report + fix baseline selection

Internal CI tooling — no published-package changes.

- The report is now two tables built from the same rows: a colors-only
  **Overview** (🟢/🟡/🔴 per metric) and a numbers **Detailed results**
  (`baseline -> pr`, with a multi-line per-dimension judge cell + stop reason),
  preceded by a collapsible glossary and followed by a short executive summary
  (paragraph + bullets), a **Potential issues** section, and a collapsed
  per-cell analysis. Dropped the old build/verdict/composite columns and the raw
  per-dimension blurb.
- New per-metric coloring vs the `main` baseline with a single tunable
  `MARGIN_PCT` (±5%), and a new **SCORE = composite ÷ cost** (composite points
  per dollar) priced from builder tokens at Bedrock Opus 4.8 rates
  (`PRICING`/`cellCost`/`scorePerDollar` in `scoring.mjs`).
- Baseline-selection fix: a PR now always diffs against `latest-main.json` (the
  current `main` tip), never the PR's stale recorded `base.sha`; a push to `main`
  diffs against the preceding main commit (`github.event.before`) by exact sha.
