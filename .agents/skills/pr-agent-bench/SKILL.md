---
name: pr-agent-bench
description: >-
  How to read and interpret an aws-blocks PR agent-bench run — what the bench report's columns,
  colored balls (🟢 ⚪ 🟡 🔴), Judge dimensions (F/S/P/C/B), composite/Score, and stop_reason values
  mean, plus a 60-second regression-triage runbook (top-line verdict → red cells → stop_reason triage
  → failure class → trace). Use when reading or interpreting aws-blocks PR agent-bench results,
  bench report columns/colors, deciding whether a PR regressed, or triaging a red/amber bench cell.
---

# Reading a PR agent-bench run

## North star — the one question

The bench exists to answer **one question per PR**: *did this change keep things steady-or-better, or
did it regress?* Every column, color, and number below is in service of answering that in seconds. A
healthy PR should be **dismissable in under 10 seconds** from the top-line alone; a genuine regression
should hand you a **failure class and a trace path** without a second tool.

> ⚠️ **Reading model vs. what's live today.** This runbook describes the *target* reading model the
> bench is being built toward. A few mechanics in it — the per-cell **noise band** recolor, the single
> **PR-verdict banner**, folded deep-dive, and per-red trace links — are **planned (v2), not yet on this
> branch**. Where a mechanic isn't live yet, the runbook tells you how to derive the same judgment from
> what the current (v1) report *does* show. See **[Implementation status](#implementation-status-as-of-pr-194)**
> for the exact live-vs-planned split. Never assume a v2 signal is present just because it's described here.

## Color semantics

Each cell's color is keyed off that cell's **noise band** — its historical run-to-run variance — not a
fixed number. The band is what makes a signal trustworthy at N=1.

| Ball | Meaning | Action |
|---|---|---|
| 🟢 green | Improved **beyond** the cell's band | Glance only — good news, no action |
| ⚪ gray | **Steady within band**, OR new / no baseline | Nothing to see — expected noise or a first observation |
| 🟡 amber | Moved the **wrong way but within band** | **Watch, don't act** — one sample of normal variance |
| 🔴 red | Composite Δ **≤ −5 AND** beyond band | **ACT** — a material, real regression |

The whole point of the band is to stop 🟡 normal-variance swings from masquerading as 🔴 regressions,
while still catching a small-but-real drop on an otherwise rock-steady cell.

> **Today (v1)** the table does *not* yet use per-cell bands. It colors each metric by its delta vs the
> baseline using **fixed thresholds**: 🟢 beyond +threshold, 🔴 beyond −threshold, 🟡 within ±threshold
> (either direction = noise), ⚪ no baseline (tagged `(new)`), 🗑️ a cell that existed in the baseline but
> is gone now. Thresholds: composite ±5, Score ±5, Judge ±0.3, Tests ±1 pass,
> Cost ±max($0.02, 10% of baseline), Turns ±3. Consequence: a big drop on a naturally-swingy cell colors
> 🔴 under v1 even when the band would call it amber (see the worked example).

## PR verdict (top-line)

The run rolls up to one of three verdicts:

- **REGRESSED** — PR composite Δ is beyond the **−band**, OR **any** scenario is 🔴.
- **IMPROVED** — PR composite Δ is beyond the **+band** AND there are **zero** 🔴.
- **STEADY** — anything else (the common, healthy case).

**STEADY or IMPROVED with 0 red → ship on bench grounds.** You're done in one glance.

> **Today (v1)** there is no single banner word. Derive the verdict yourself from the preword bullets:
> the *"Mean composite X/100 — 🟢/🟡/🔴 Δ vs `main`"* line (its ball uses a ±5 composite band) plus the
> count of 🔴 / 🟡 cells in the table. The per-cell `verdict` tally in the preword
> (`pass · partial · fail · harness_error`) is a *different* field — see [reference](#reference-what-the-current-v1-report-contains).

## How to read a run in 60 seconds

**Step 0 — Top-line only.** Read the verdict + composite Δ + counts of 🔴 / 🟡. If **STEADY / IMPROVED
and 0 red → stop here and ship** (on bench grounds). Most PRs end at Step 0.

**Step 1 — If red, read each red's structured line.** For every 🔴 cell, pull its one line: composite Δ,
worst Judge dimension, `stop_reason`, and trace path. Do not open anything yet.

**Step 2 — Triage the cell's CLASS FIRST (before acting on the score).** A 0 means different things
depending on the cell's class, and only *one* class is excluded noise. Match the red cell to one of three
buckets — this mirrors the mean-inclusion rule and the `pass · partial · fail · harness_error` tally in the
[Reference](#reference-what-the-current-v1-report-contains):

| Class | Signal (`stop_reason` / status) | In the headline mean? | What its 0 means → action |
|---|---|---|---|
| **`harness_error`** | `cancelled` (CI abort); a pre-grade failure (`preflight_failed`, `oidc_failed`, `init_abort`); an **ungraceful** step-2 death under active isolation (surfaces as `in_progress` / no terminal stop_reason) | **EXCLUDED** from the mean | The harness or CI died before the agent's work could be judged. **NOT a PR signal → RE-RUN the cell.** |
| **`agent_fail` / `dead_server`** | `agent_fail`: graceful `wall_clock_timeout` (ran out of its time budget), `max_tokens` / `error` (hit its output-token budget), `agent_timeout`. `dead_server`: `dev_server_dead` (app built but its dev-server never served / crashed) | **INCLUDED as composite 0 — this 0 moved the mean** | A **genuine, counted failure** — *not* excluded noise. The `stop_reason` tells you whether a **re-run** might recover it (a transient budget / throttle blip) or whether it's a persistent agent budget / quality regression. Re-run to disambiguate, but it counts as a real data point until it does. |
| **`scored`** | `end_turn` / `tool_use` / `stop_sequence` **with a dropped composite** | INCLUDED — graded on its tests | The agent finished and the result genuinely got worse → **real agent-quality regression → dig** (Step 3). |

**The trap to avoid:** only **`harness_error`** is excluded / "not a PR signal." `agent_fail` (incl. `max_tokens`,
`agent_timeout`, graceful `wall_clock_timeout`) and `dead_server` are **counted composite-0 failures** that
already dragged the headline mean — a re-run tells you *transient vs. real*, but never wave them off as
"infra noise."

**Step 3 — Worst dimension → failure class → where to look.** The Judge's lowest dimension points you
straight at the code. The table's Judge column shows only the **averaged** score — the per-dimension
scores (F/S/P/C/B) are **not** in the at-a-glance row; read them from the cell's judge artifact JSON
(`bench-result-<task>-<template>` → `result.json` → `judge_dimensions`) to find the lowest one, then map
it here:

| Dimension ↓ (letter) | Failure class | Where to look |
|---|---|---|
| **functional_completeness** (F) | Task not done | The **feature code the PR touched** |
| **selector_contract** (S) | Selectors broke | **DOM / UI contract drift** (renamed ids, moved elements) |
| **persistence** (P) | State didn't survive | **State / storage / auth round-trip** broken |
| **code_quality** (C) | Quality regressed | The generated code got worse |
| **blocks_fidelity** (B) | Stopped using the framework idiomatically | **KEY signal for framework PRs** — the change nudged the agent away from Blocks idioms |

**Step 4 — Open the trace, confirm root cause, decide.** Open the cell's trace at its
[stable artifact path](#finding-the-trace-and-per-cell-artifacts), confirm the root cause, then **fix vs
revert**.

**Step 5 — Amber is a watch-list, not a blocker.** 🟡 cells are non-blocking on their own. But if the
**same cell** goes amber across **consecutive PRs**, that's a **slow regression** creeping in under the
band — investigate it proactively.

## Materiality rule

**🔴 requires BOTH conditions: composite Δ ≤ −5 AND beyond the cell's noise band.**

- The band kills **variance false-alarms** (a swingy cell dropping within its normal range is amber, not red).
- The **−5 floor** is a materiality gate: it catches a real, small regression on an otherwise steady cell,
  and refuses to raise the alarm for a sub-threshold wobble. −5 composite points is the minimum drop worth
  a human's attention.

## Worked example — run `29464250153` (a real messy run)

This run shows why Step 2 (`stop_reason` first) and the noise band exist:

- **`cognito` scored 0** via a **`max_tokens` stop** — a **counted `agent_fail`** (composite 0, INCLUDED in
  the mean), *not* excluded harness noise: this 0 genuinely dragged the headline down. Its `stop_reason`
  flags it as budget-exhaustion a **re-run** might recover — and the re-run scored **92**, confirming it was
  **transient, not a real regression**. A reader who took the 0 as a settled quality verdict instead of
  re-running to disambiguate transient-vs-real would have chased a phantom regression.
- **`auth-notes` posted a −78.8 composite delta** — alarming at first glance, and **v1's fixed ±5
  threshold colors it 🔴**. But that cell's **historical band is 11.6–94.4**: its composite naturally
  swings across nearly the whole range, so −78.8 lands **within band → 🟡 amber / watch, NOT a red
  ship-blocker.** This is the exact case the band is designed to reclassify.

Takeaway: **`stop_reason`-triage + the noise band together prevent phantom-regression chases.** Without
them, this run reads as two hard regressions; with them, it reads as "one counted-but-transient `agent_fail`
a re-run cleared, one watch-list amber."

## Finding the trace and per-cell artifacts

Each scenario cell writes three GitHub Actions artifacts, named `<kind>-<task>-<template>`:

| Artifact | Contents |
|---|---|
| `bench-result-<task>-<template>` | `result.json` — the cell's scored result |
| `bench-source-<task>-<template>` | the app the agent actually produced |
| `bench-trace-<task>-<template>` | **`trace.json`** — the full agent trace (what you open in Step 4) |

Aggregate results also land in S3 at `s3://<bucket>/bench/runs/<SHA>/results.json` (with a
`bench/runs/latest-main.json` pointer to the most recent **main** run — the baseline).

> **Caveat:** only an **ungraceful GitHub `SIGKILL`** — the runner hard-killing the step at
> `timeout-minutes: 35` before the graceful flush runs — writes **no `trace.json`** at all. The
> internal-deadline path (`BENCH_AGENT_DEADLINE_SEC`, default 2010s — the common budget-exhaustion
> case, `stop_reason: wall_clock_timeout`) now flushes a **message-only `trace.json`** before exit
> (span traces absent, but the per-turn toolUse/toolResult messages are there), so a timed-out cell is
> usually still analyzable. When there's genuinely no trace, the stop reason *is* your answer:
> infra → re-run.
>
> **Today (v1)** the report links **one run-level Artifacts page** (in the collapsed glossary); you find
> the per-cell trace by opening that run's Artifacts and grabbing `bench-trace-<task>-<template>`.
> **Per-red deep links straight to a cell's trace are planned (v2), not yet live.**

## Implementation status (as of PR #194)

**LIVE now on this branch (v1 — the slimmed single table):**

- **One results table**, columns in order: **`Task | Template | Tests | Judge | Cost | Turns | Score | Stop reason`** (no Composite column in the table).
- **Fixed-threshold** per-metric delta coloring (🟢 / 🔴 beyond ±threshold, 🟡 within, ⚪ `(new)` no baseline, 🗑️ removed) — **not** per-cell noise bands.
- Cell format `<ball> <value> (<Δ>)`; Tests = `<ball> passed/denom (±n)`; Judge = `<ball> <overall> (<Δ>)` — the **averaged** judge score + color + Δ **only** (the per-dimension F/S/P/C/B scores are **not** in the row; they live in the judge artifact JSON — see [reference](#reference-what-the-current-v1-report-contains)); **Stop reason is the raw string with no ball.**
- Headline is the **preword bullets**, not a one-word banner: *Mean composite X/100 — 🟢/🟡/🔴 Δ vs `main`*, a `pass · partial · fail · harness_error` verdict tally, totals, biggest gains/drops, config (+ an optional `BENCH_MIN_SCORE` gate line).
- Deep-dive analysis (`## Executive summary`, `## 🔴 Failure root-cause`, `## ⚠️ Potential issues`, `## Per-cell analysis`) is appended **inline / always-present collapsed `<details>`** — the failure section renders inline only when failing cells carry analysis.
- Trace access = **one run-level Artifacts link** in the glossary.

**PLANNED (v2 — described in this runbook, NOT yet implemented):**

- **Band-based recolor** — coloring keyed off each cell's historical-variance **noise band** instead of fixed thresholds.
- **First-class PR-level composite headline + single PR-verdict banner** (`REGRESSED / IMPROVED / STEADY`).
- **Folded `<details>` deep-dive** that expands **only on red**.
- **Per-red trace-path links** straight from a red cell to its `trace.json`.

Until v2 lands, apply the runbook by deriving these from the v1 signals as noted in each section above.

## Reference: what the current (v1) report contains

- **Judge:** 5 dimensions, each 0–10, averaged equally → overall Judge score (F=functional_completeness,
  S=selector_contract, P=persistence, C=code_quality, B=blocks_fidelity). The **table's Judge column shows
  only the averaged score** + color + Δ; the per-dimension F/S/P/C/B scores are recorded in the judge
  artifact JSON (`result.json` → `judge_dimensions`) — progressive disclosure — **not** rendered in the
  at-a-glance row.
- **Composite (0–100):** `60·pass_rate + 4·judge·min(1, 4·pass_rate)` — 60% objective test pass-rate + 40%
  Judge, with the Judge term ramped in only above a 25% pass-rate (too little objective evidence below that).
- **Score:** composite ÷ builder $-cost (higher is better). Builder is Opus 4.8; pricing $5 in / $25 out per 1M tokens.
- **`compositeBand`** (absolute: ≥80 🟢 / ≥50 🟡 / else 🔴) is used **only** in the per-cell analysis
  `<details>` headers, **not** in the table's coloring.
- **Per-cell `verdict` enum:** `pass` (rate ≥ 0.999) · `partial` (rate > 0) · `fail` (rate 0) ·
  `harness_error` · `unknown` (no tests ran). This is the tally in the preword — distinct from the
  planned PR-level REGRESSED/IMPROVED/STEADY verdict.
- **`stop_reason` values seen in the column:** `end_turn`, `max_tokens`, `tool_use`, `stop_sequence`
  (normal SDK finishes); `error` (invoke exhausted / max-tokens error); `wall_clock_timeout` (killed on
  deadline); `cancelled`; `in_progress` (a checkpoint survivor).
- **Cell classes (for the mean):** `scored` · `harness_error` (**excluded** from the mean) · `agent_fail`
  (composite 0, **included**) · `dead_server` (composite 0, **included**). Analysis constants:
  `REGRESSION_DELTA = -5`, `LOW_THRESHOLD = 50`.
- **Baseline:** `bench/runs/latest-main.json` — the most recent **main** bench run, not the PR's merge base.

## Acceptance — "eminently usable"

- A **healthy PR is dismissable in < 10 seconds** from the top-line alone (verdict + composite Δ + 0 red).
- A **red gives you the failure class + trace path without needing a second tool** — everything to start
  the fix-vs-revert decision is on the cell's one structured line.
