---
---

feat(bench): redesign agent-bench PR-vs-`main` report + fix baseline selection

Internal CI tooling — no published-package changes.

- The report is now a SINGLE results table built from the run's cells
  (`TASK · TEMPLATE · TESTS · JUDGE · COST · TURNS · SCORE · STOP REASON`),
  preceded by a collapsible glossary + the headline (mean composite + delta) and
  followed by a short executive summary (paragraph + bullets), a **Potential
  issues** section, and a collapsed per-cell analysis. Replaces the old
  two-table layout (a colors-only Overview + a numbers Detailed table) and drops
  the standalone `Δ vs base` column. The table was later slimmed for readability:
  the `TOKENS`, `LOC`, and `Files` columns were removed (those counts are still
  persisted to the S3 baseline for offline analysis, just no longer rendered).
- Each metric cell is a single inline line (`<color> <value> (<Δ vs main>)`): the
  current value with its signed delta vs the `main` baseline, colored by the
  significance + direction of the change via the per-metric `DELTA_THRESHOLDS`
  (composite/score ±5, judge ±0.3, tests ±1, cost ±10%, turns ±3;
  tests/judge/score higher-better, cost/turns lower-better; within band → 🟡,
  beyond → 🟢/🔴). The JUDGE cell is compacted onto that one line — the overall
  judge score with its signed delta. When the baseline has no value
  for a field, the cell still shows the current value tagged `⚪ (new)` — decided
  per field, so a partial baseline no longer forces the whole row to be treated
  as new.
- New **SCORE = composite ÷ cost** (composite points per dollar) priced from
  builder tokens at Bedrock Opus 4.8 rates (`PRICING`/`cellCost`/`scorePerDollar`
  in `scoring.mjs`).
- Baseline-selection fix: a PR now always diffs against `latest-main.json` (the
  current `main` tip), never the PR's stale recorded `base.sha`; a push to `main`
  diffs against the preceding main commit (`github.event.before`) by exact sha.

Bench integrity + failure-analysis honesty (harness self-scoring fixes):

- The builder now persists a `trace.json` on EVERY exit path (success,
  invoke-exhausted error, and the wall-clock / internal-deadline flush) and
  captures `toolResult` blocks (tool outputs + errors) via a `MessageAddedEvent`
  hook. Previously a non-returning `invoke()` (e.g. a `MaxTokensError`) left no
  trace — an unanalyzable silent 0 — and traces held only `toolUse` blocks, so
  tool error text was unrecoverable.
- A `MaxTokensError` cell is now classified `agent_fail` with its own
  `klass_reason='max_tokens'` (still composite 0, still INCLUDED) instead of
  being mislabeled `agent_timeout`; only genuine wall-clock timeouts keep
  `agent_timeout`.
- The deep failure-analysis pass now short-circuits deterministically for
  `harness_error` / no-trace / `failed_at==='2-agent'` cells (matching the cheap
  analysis pass), so an ungrounded model can no longer confabulate a root
  cause/owner; and seeded pessimistic build defaults from a SKIPPED build step
  are reported as "not run / no build evidence" rather than an observed build
  failure.
- The builder arms a self-imposed internal deadline (~33.5 min, before GitHub's
  35-min hard kill) that flushes a graceful partial envelope + trace, so a
  budget-exhausted cell is no longer ungracefully killed leaving only a checkpoint.
