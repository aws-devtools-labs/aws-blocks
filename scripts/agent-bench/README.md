# Agent Bench

Per-PR LLM-agent benchmark. For each (task, template) cell, a builder agent
implements the task's `PROMPT.md` in a pre-scaffolded app, the build runs,
Playwright grades the result, and a judge agent scores against the rubric.

## Architecture

Nine steps per cell, all on the GitHub runner (4b and 6b are best-effort auxiliaries):

0. **Init result** — write a baseline `result.json` before any AWS call, so
   even an OIDC failure still produces a cell row in the summary
1. **Init** — build the local registry and scaffold a fresh app. No dev server
   is started here — the verifier (step 3) owns launching it and discovering its
   port, so the agent's edit phase runs with nothing bound
2. **Agent run** — Strands + Bedrock; the agent has the framework's vended
   `bash` + `fileEditor` tools, both routed through a `WORKSPACE`-rooted Sandbox
   (`lib/run-shell.ts`). The workspace is already scaffolded; no dev server is
   running (the agent must not rely on or start one).
3. **Build and test** — `npm run build`, then launch the dev server fresh and
   discover the port it binds by anchoring on the framework's startup banner
   (`AWS Blocks local server running on http://localhost:<port>`) — no port
   guessing — exported as `APP_BASE_URL`; then run the task's Playwright spec
   against it. Records build / dev-server / playwright / test signals
4. **Judge** — Strands + Bedrock; one vended `bash` tool rooted at a
   spec-blinded, disposable source-only COPY of the workspace
   (`lib/run-shell.ts`); any writes it makes to the copy can't affect scoring.
   Scores source only; objective signals are applied as caps afterward, not
   shown to it.
   - **4b. Analyze cell** (best-effort) — asks the judge model for a concise
     2–4 sentence analysis of this cell's fresh `trace.json` + `metrics.json`
     plus a short list of potential issues, and writes both back into
     `result.json` as `analysis` + `analysis_issues[]` (`analyze-cell.mjs`); the
     summary job later rolls these up
5. **Upload result** — JSON artifact + S3 archive (best-effort)
6. **Upload source** — uploads the generated `bench-app` as
   `bench-source-<task>-<template>` for post-run auditing, excluding deps/build
   output and anything credential-shaped (`node_modules`, `.git`, `dist`,
   `.env*`, `*.pem`, `.aws`)
   - **6b. Upload trace** (best-effort) — the agent trace + run metrics written
     by step 2; on a wall-clock timeout step 2 emits no trace, so nothing uploads

No microVM, no S3 transport between runner and sandbox. The runner is the
sandbox; Bedrock provides the model. Builder and judge use different models
(Sonnet 4.6 vs Opus 4.8) to limit same-model self-evaluation bias.

## Security

The builder step (`2. Agent run`) executes an LLM-driven agent with vended
`bash` + `fileEditor` tools **inside the job's shell environment**, which holds
the live OIDC/AWS session minted by the `Configure AWS credentials` step. A
prompt-injected or
otherwise malicious task `PROMPT.md` could therefore, in principle, drive the
agent to reach **any AWS API within the role's scope** — i.e. Bedrock
(`InvokeModelWithResponseStream` on the bench model) and the registry bucket
(`s3:PutObject` on `bench/*`) — not just the build it was asked to perform.

This is bounded by **who can trigger the bench, not by sandboxing the agent**:
the matrix runs only on the same repo. It runs automatically on every same-repo
pull request (opened / synchronized / reopened) and on every push to `main`,
plus manual `workflow_dispatch` — there is **no label gate**. The same-repo guard
is enforced in
[`pr-agent-bench.yml`](../../.github/workflows/pr-agent-bench.yml): fork PRs get
no secrets or OIDC under `pull_request`, so an external contributor cannot reach
the role at all (push-to-`main` is same-repo by definition). The task `PROMPT.md`
files are themselves in-repo and member-reviewed.

**Future hardening (not yet implemented):** scope the builder step to a
dedicated, minimal **Bedrock-invoke-only** role (drop the `s3:PutObject` grant,
which only the separate "Persist to S3" step needs) so a compromised agent has
the smallest possible blast radius even within a trusted trigger.

## Tasks

Each task is a directory under `tasks/` with a `PROMPT.md` (given to the
builder — the task OBJECTIVE and selector contract only, no framework how-to;
the agent learns the framework from the scaffolded app's own `README.md`) and a
`test.spec.ts` (Playwright, graded — never shown to the builder or the judge).
The judge scores every task on the same fixed shared rubric — the dimensions in
`COMMON_DIMENSIONS` (`lib/scoring.mjs`, the source of truth), see *Judge
dimensions* below — there is no per-task dimension to author.

| Task | Template | Blocks exercised |
|------|----------|------------------|
| `auth-notes` | `demo` | AuthBasic + KVStore |
| `file-gallery` | `bare` | FileBucket |
| `async-word-counter` | `bare` | AsyncJob + KVStore |
| `collab-presence-board` | `default` | Realtime + DistributedTable |
| `cognito-profile` | `auth-cognito` | AuthCognito (email-OTP) |
| `observability-api` | `backend` | Logger + Metrics + Tracer + AppSetting |
| `sql-kb-catalog` | `nextjs` | Database + KnowledgeBase |
| `oidc-dsql-notes` | `react` | AuthOIDC + DistributedDatabase |
| `email-digest` | `demo` | CronJob + EmailClient + KVStore |
| `kb-chat-agent` | `demo` | Agent (Bedrock Sonnet 4.6) + KnowledgeBase + tool use |

These 10 cells cover 18 Building Blocks across 7 templates. The matrix in
`pr-agent-bench.yml` is an explicit `include:` list of (task, template) pairs —
not a cross-product: each task runs on the single template that pre-ships (or
best exercises) its blocks, to bound Bedrock spend. The `task` name is part of
`result.json`, the artifact name (`bench-result-<task>-<template>`) and the S3
key, so cells never collide.

## Scoring methodology (pre-registered)

Fixed in advance so a score can't be reverse-justified. All of it is
single-sourced in [`steps/lib/scoring.mjs`](steps/lib/scoring.mjs) and imported
by **both** `finalize-result.mjs` (which stamps it onto every `result.json`)
and `summary.mjs` (which renders it) — one implementation of the formulas, the
verdict tiers, and the exclusion rule, so the published numbers and the rendered
table can't drift apart.

**Composite (0–100)**, per cell:

```
tr        = tests_passed / (tests_passed + tests_failed)   # 0 if no tests ran
judge     = overall judge score, 0–10 (0 if the judge errored)
composite = round( 60*tr + 4*judge*min(1, 4*tr) , 1 )
```

60% is the objective pass-rate, 40% is the judge. The `min(1, 4*tr)` gate ties
the judge term to the tests: a cell with **zero** passing tests floors to 0
whatever the judge said, and the judge term only reaches full weight once ≥25%
of tests pass. A judge failure (`judge=0`) drops *only* its 40% — never the
test-driven 60%. Bands: ≥80 🟢, ≥50 🟡, else 🔴.

**Cost & Score (per cell).** COST is the **builder's** token spend priced at
Bedrock Claude Sonnet rates — `$3` / 1M input, `$15` / 1M output
(`PRICING` / `BUILDER_PRICING` in `lib/scoring.mjs`, the one place to edit when
AWS pricing or the builder model changes). The judge and analysis run on Opus,
but that spend is the harness's, not the agent's, so it is not counted. **SCORE**
= `composite ÷ cost` — composite points per **dollar**, higher = better. Cost, not
raw token volume, is the denominator, so token count can't *dominate* the metric,
and a broken (composite 0) cell scores 0 no matter how cheap it was. A cell with
no recorded tokens renders `—` (never a fake `$0`). Flip the single
`SCORE_PER_DOLLAR` constant in `lib/scoring.mjs` for cost-per-point instead.

**Colors vs baseline (per metric).** In the report every metric cell is colored
against the baseline value for that metric: 🟢 same-or-better · 🟡 worse but
within the margin · 🔴 worse beyond it · 🆕 no baseline value (new cell) · `—`
nothing to diff · 🗑️ cell gone since the baseline. The margin is a SINGLE tunable,
`MARGIN_PCT` (5% relative) in `lib/overview.mjs`; for integer metrics (test
counts, 0–10 judge dims) it is floored to 1, so a single-point nudge reads 🟡,
never 🔴. Directions: tests ↑, judge ↑, score ↑ are better (higher = 🟢); cost ↓,
tokens ↓ are better (lower = 🟢).

**Verdict tiers** are pure pass-rate — the judge plays no part, so an LLM
failure can never flip a verdict:

| Verdict | Condition |
|---------|-----------|
| `pass` | pass-rate ≥ 0.999 |
| `partial` | 0 < pass-rate < 0.999 |
| `fail` | pass-rate == 0 with tests that ran, **or** an agent failure (the builder timed out / produced no app at `2-agent`) — scored as composite 0 |
| `unknown` | no tests ran on an otherwise-gradeable cell (denominator 0) — excluded from the mean |
| `harness_error` | never produced a gradeable artifact: pre-flight / OIDC / scaffold, or a cancellation — excluded from the mean |

**Judge dimensions.** A fixed set of shared dimensions — defined once in
`COMMON_DIMENSIONS` (`lib/scoring.mjs`, the source of truth), currently
`functional_completeness`, `selector_contract`, `persistence`, `code_quality`,
`blocks_fidelity` — applied uniformly to every task with no per-task dimension,
all 0–10, **averaged equally** (no weights — they invite anchoring bias). The
overall is recomputed
deterministically from the dimensions, never read from free text. Objective
signals (build, dev-server) are applied as deterministic **hard caps**
*after* the judge returns and are never shown to the model; the test pass-rate
is recorded for audit but caps no judge dimension. A *scaffold* failure is not a
judge cap — it fails step 1 (`1-init`), so the cell becomes a `harness_error`
(excluded from the mean) before the judge ever runs.

**Spec-blinding.** The judge grades a source-only COPY of the workspace with the
objective test spec removed: `bench-tests/` (where step 3 stages the spec) and
every `*.spec.{ts,tsx,js,jsx,cjs,mjs}` CODE file are excluded from the copy, so
the judge is blinded by ABSENCE — no `cat`/`grep`/`find` can reach a spec that
physically isn't there — and a post-copy `find` (`4-judge.ts`
`assertNoSpecLeak`) fails loudly if one ever leaks in. Framework-generated
`*.spec.json` manifests (e.g. `aws-blocks/blocks.spec.json`, the OpenRPC
contract) are deliberately NOT treated as leaks: they are build artifacts, not
the bench objective.

**Exclusion rules.** A cell enters the headline mean iff it is gradeable — the
single `isScoredCell()` in `lib/scoring.mjs`. Two buckets are EXCLUDED and
reported separately, so infra failure reads as infra rather than as a low score:
`harness_error` (pre-flight / OIDC / scaffold, or a cancellation — it never
produced a gradeable artifact) and a gradeable cell that ran no tests
(`unknown`, denominator 0). An **agent failure** — the builder timing out or
producing no app within its budget at `2-agent` — is the one no-tests case that
still counts: the agent is exactly what's under test, so it scores as a genuine
`fail` / composite 0 and IS included in the mean.

**Reps.** The bench runs **N=1** — a single rep per cell. Each cell produces
exactly one `result.json`, and the summary scores that one rep directly: there
is no multi-rep aggregation, median, or IQR. Re-introducing multi-rep support
(execution loop + dispersion reporting) is tracked in #96.

**Reproducibility pins.** The builder pins `temperature=0` (Sonnet 4.6); the
judge (Opus 4.8) rejects `temperature`, so its determinism rests on the
structured-output schema + the deterministic hard caps. Model IDs are pinned
snapshots (the Claude 4.x IDs carry no date suffix — the version *is* the
snapshot). Playwright is pinned to `1.60.0` and runs with `retries: 0` — a retry
would mask realtime-propagation flake, and the bench wants an honest pass/fail
for the judge. A run-stable `RUN_ID` seeds the specs' unique-but-deterministic
data so identifiers stay collision-free across a spec's internal navigation.

**Re-derivability.** Each `result.json` publishes `tests_passed`/`tests_total`,
`test_rate`, the raw per-dimension judge scores (pre-cap `judge_dimensions_raw`
and post-cap `judge_dimensions`), `judge_overall`, `composite`, `verdict`,
`klass`, the builder `tokens_in`/`tokens_out`, and `stop_reason`. The **Detailed
results** table renders every post-cap dimension inline (one colored
`baseline -> pr` line per dimension in its Judge cell), and the cost + score are
derived from the published tokens via `lib/scoring.mjs`. A reader can re-derive —
or re-weight — every composite, cost and score from the published data without
re-running anything.

**Gating.** Observational by default: with the repo/org variable
`BENCH_MIN_SCORE` unset the summary only reports the mean composite. Set it to a
number to gate — the summary job exits non-zero when the mean composite across
scored cells falls below it; this is the **one** intentional exception to
green-regardless (below). There is no baseline-*delta* gate — the PR-vs-baseline
overview (below) is observational only.

**Check status — green regardless.** A bench cell never turns the PR check red.
Every fallible cell step (`npm ci`, OIDC, `1-init`, `2-agent`, `3-build-and-test`,
`4-judge`) is `continue-on-error: true`, paired with an explicit
`if: steps.<prev>.outcome == 'success'` chain that reproduces the old implicit
skip-chain — so an agent timeout still skips its tests/judge and scores composite
0, rather than scoring a partial app. A cell's outcome lives in `result.json` +
the run summary, not the check status, and the summary job is green too (unless
`BENCH_MIN_SCORE` is set and trips). A new commit cancels the prior in-flight run
via the workflow `concurrency` group.

**The report — Overview + Detailed vs the `main` baseline.** Each run writes a
compact **aggregate** (per cell: composite/verdict, test counts, per-dimension
judge scores, builder tokens, cost, and score-per-$, plus the mean) to S3 at
`bench/runs/<sha>/results.json`; a push-to-`main` run also updates the stable
pointer `bench/runs/latest-main.json`. The summary job fetches a baseline and
renders TWO tables from the SAME rows (`lib/overview.mjs`):

- **Overview** — colors ONLY (🟢/🟡/🔴 per metric vs baseline), at-a-glance:
  `TASK · TEMPLATE · TESTS · JUDGE · COST · TOKENS (in/out) · SCORE`.
- **Detailed results** — the same rows widened WITH numbers (`baseline -> pr`),
  including a multi-line per-dimension Judge cell and the cell's stop reason.

A collapsible **Glossary** (scoring, colors, the ±5% margin) sits at the very
top; a best-effort roll-up step (`analyze.mjs`) then appends an **Executive
summary** (a short paragraph + bullets), a **Potential issues** section (fed by
each cell's own analysis), and a collapsed **Per-cell analysis** (each cell also
collapsed within it). The old `build` / `verdict` / `composite` columns and the
raw per-dimension blurb are gone — folded into the two tables above.

**Baseline selection.** The baseline a **PR** diffs against is ALWAYS the most
recent `main`-branch bench, `bench/runs/latest-main.json` — the current tip of
`main`, NOT the PR's recorded base commit. `github.event.pull_request.base.sha`
is captured when the PR is opened / last synced and goes stale as `main` advances,
so an exact-base-sha lookup can silently diff against an outdated or never-benched
commit; `latest-main.json`, refreshed on every push to `main`, can't. A **push to
`main`** instead diffs against the immediately preceding main commit
(`github.event.before`) by exact sha — the ONLY place a commit-keyed baseline is
read — with `latest-main` as the fallback. With no baseline found the tables show
absolute values (every metric 🆕) and a "no baseline" note (never an error).
Reading/writing the baseline uses the same OIDC role (`s3:GetObject` /
`s3:PutObject` on `bench/*`); a missing grant just degrades to "no baseline".

## Files

`steps/` mirrors the workflow 1:1 — `ls` shows the pipeline.

| File | Purpose |
|------|---------|
| `prompts.ts` | Builder + judge system prompts; the fixed shared rubric dimensions + rubric composer |
| `steps/0-init-result.mjs` | Write a baseline `result.json` so failed cells still produce an artifact |
| `steps/1-init-bench-app.sh` | Build packages, pack the local registry, scaffold the app, seed the telemetry canary from `BLOCKS_TELEMETRY_CANARY_ID` (optional — skipped with a warning if unset), no dev server (the verifier owns that) |
| `steps/2-agent-run.ts` | Builder agent (Strands + Bedrock); vended `bash` + `fileEditor` tools; capped at `MAX_TURNS` |
| `steps/3-build-and-test.sh` | `npm run build` + Playwright spec; writes build / dev-server / playwright / test signals to `$GITHUB_OUTPUT` |
| `steps/4-judge.ts` | Judge agent (Strands + Bedrock); one vended `bash` tool over a spec-blinded, disposable source-only copy; grades on the fixed shared rubric (`COMMON_DIMENSIONS`) and applies hard caps |
| `steps/lib/run-shell.ts` | Shared shell infrastructure for the builder + judge: the `WorkspaceSandbox` (host-execution Sandbox rooted at a fixed dir) + a backgrounded-process-safe runner. The containment fix lives here once; imported by `2-agent-run.ts` and `4-judge.ts` |
| `steps/lib/scoring.mjs` | **Single source of truth** for scoring: `classifyCell`, `testStats`/`testRate`, `verdict`/`verdictOf`, `composite`/`compositeBand`, `isScoredCell`, plus the cost/score model — `PRICING`/`BUILDER_PRICING`, `cellCost`, `scorePerDollar` (+ the `SCORE_PER_DOLLAR` knob). Imported by finalize, summary, and overview |
| `steps/lib/overview.mjs` | Pure helpers for the two report tables: `buildAggregate` (schema-2 aggregate — per-cell composite/tests/judge-dims/tokens/cost/score/stop_reason + mean), `diffAgainstBaseline`, the color engine (`MARGIN_PCT`, `metricColor`), formatters, and `renderOverview` (colors) + `renderDetailed` (numbers). Imported by summary + analyze |
| `steps/lib/analysis.mjs` | Shared, mostly-pure helpers for the trace/metrics analysis feature: trace trimming, prompt builders, and `parseCellAnalysis` (splits the per-cell model output into an analysis string + a bounded potential-issues list). Imported by `analyze-cell.mjs` (per-cell) and `analyze.mjs` (roll-up) |
| `steps/analyze-cell.mjs` | Step 4b: per-cell trace/metrics analysis via the judge model; writes a concise `analysis` string **and** an `analysis_issues[]` (potential issues) back into the cell's `result.json` |
| `steps/analyze.mjs` | Summary-job roll-up: synthesizes the per-cell analyses into a short **Executive summary** (paragraph + bullets) via one best-effort Bedrock call, aggregates a **Potential issues** section, and renders a collapsed **Per-cell analysis** (each cell also collapsed) |
| `steps/finalize-result.mjs` | Run with `if: always()`; stamps `status` + `failed_at` from per-step outcomes, then `klass`, `test_rate`, `verdict`, `composite` via `lib/scoring.mjs` |
| `steps/summary.mjs` | Render the report to `$GITHUB_STEP_SUMMARY`: a collapsible **Glossary**, the colors-only **Overview** + numbers **Detailed results** tables (vs the `main` baseline), and a deterministic caveats block; reads one `result.json` per cell (N=1); writes the run's schema-2 aggregate (+ Athena NDJSON) for the S3 baseline; optional `BENCH_MIN_SCORE` gate |
| `package.json` | Workspace metadata; `private: true` |

Failure handling: every cell starts with `0-init-result.mjs` writing a
pessimistic baseline. Each successful step augments it. `finalize-result.mjs`
runs with `if: always()` and stamps `status: scored` (all steps green),
`status: error, failed_at: <step>` (a tracked step failed), or
`failed_at: pre-oidc` (something before OIDC — e.g. `npm ci` — failed). The
upload step also runs with `if: always()`, so the cell always shows up in the
summary table — never silently missing.

The report is written to the **GitHub Actions run summary**
(`$GITHUB_STEP_SUMMARY`) and renders in the run UI — the Glossary, the Overview +
Detailed tables, then the executive summary / potential issues / per-cell
analysis. The bench posts **no PR comment** — the github-script commenting step in
`agent-bench.yml` is intentionally left in place but commented out, so it can be
restored if commenting is ever wanted again. When the bench matrix produces no
results, `summary.mjs` renders a benign "no results" note and still exits 0.

## Local development

Each step is runnable directly with the right env. Example for the builder
(the workspace must already be scaffolded; no dev server is needed):

```bash
WORKSPACE=/tmp/bench-app \
TASK_PROMPT=tasks/auth-notes/PROMPT.md \
OUTPUT=/tmp/builder-result.json \
  npx tsx scripts/agent-bench/steps/2-agent-run.ts
```
