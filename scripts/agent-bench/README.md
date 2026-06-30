# Agent Bench

Per-PR LLM-agent benchmark. For each (task, template) cell, a builder agent
implements the task's `PROMPT.md` in a pre-scaffolded app, the build runs,
Playwright grades the result, and a judge agent scores against the rubric.

## Architecture

Seven steps per cell, all on the GitHub runner:

0. **Init result** — write a baseline `result.json` before any AWS call, so
   even an OIDC failure still produces a cell row in the summary
1. **Init** — build the local registry, scaffold a fresh app, start the dev
   server, and write its port to `/tmp/dev.port`
2. **Agent run** — Strands + Bedrock; the agent has one tool (`shell`). The
   workspace is already scaffolded and the dev server is already running.
3. **Build and test** — `npm run build` + the task's Playwright spec; probes the
   dev server and records build / dev-server / playwright / test signals
4. **Judge** — Strands + Bedrock; two read-only tools (`view`, `list`). Scores
   source only; objective signals are applied as caps afterward, not shown to it.
5. **Upload result** — JSON artifact + S3 archive (best-effort)
6. **Upload source** — uploads the generated `bench-app` as
   `bench-source-<task>-<template>` for post-run auditing, excluding deps/build
   output and anything credential-shaped (`node_modules`, `.git`, `dist`,
   `.env*`, `*.pem`, `.aws`)

No microVM, no S3 transport between runner and sandbox. The runner is the
sandbox; Bedrock provides the model. Builder and judge use different models
(Sonnet 4.6 vs Opus 4.8) to limit same-model self-evaluation bias.

## Security

The builder step (`2. Agent run`) executes an LLM-driven agent with a `shell`
tool **inside the job's shell environment**, which holds the live OIDC/AWS
session minted by the `Configure AWS credentials` step. A prompt-injected or
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
builder) and a `test.spec.ts` (Playwright). The judge scores every task on the
same fixed 5-dimension rubric (see *Judge dimensions* below) — there is no
per-task dimension to author.

| Task | Template | Blocks exercised |
|------|----------|------------------|
| `auth-notes` | `demo` | AuthBasic + KVStore |
| `file-gallery` | `bare` | FileBucket |
| `async-word-counter` | `bare` | AsyncJob + KVStore |
| `collab-cursor-board` | `default` | Realtime + DistributedTable |
| `cognito-profile` | `auth-cognito` | AuthCognito (email-OTP) |
| `observability-api` | `backend` | Logger + Metrics + Tracer + AppSetting |
| `sql-kb-catalog` | `nextjs` | Database + KnowledgeBase |
| `oidc-dsql-notes` | `default` | AuthOIDC + DistributedDatabase |
| `email-digest` | `demo` | CronJob + EmailClient + KVStore |
| `kb-chat-agent` | `demo` | Agent (Bedrock Sonnet 4.6) + KnowledgeBase + tool use |

These 10 cells cover 18 Building Blocks across 6 templates. The matrix in
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
composite = round( 60*tr + 40*(judge/10)*min(1, 4*tr) , 1 )   # == 60*tr + 4*judge*min(1, 4*tr)
```

60% is the objective pass-rate, 40% is the judge. The `min(1, 4*tr)` gate ties
the judge term to the tests: a cell with **zero** passing tests floors to 0
whatever the judge said, and the judge term only reaches full weight once ≥25%
of tests pass. A judge failure (`judge=0`) drops *only* its 40% — never the
test-driven 60%. Bands: ≥80 🟢, ≥50 🟡, else 🔴.

**Verdict tiers** are pure pass-rate — the judge plays no part, so an LLM
failure can never flip a verdict:

| Verdict | Condition |
|---------|-----------|
| `pass` | pass-rate ≥ 0.999 |
| `partial` | 0 < pass-rate < 0.999 |
| `fail` | pass-rate == 0 with tests that ran, **or** an agent failure (the builder timed out / produced no app at `2-agent`) — scored as composite 0 |
| `unknown` | no tests ran on an otherwise-gradeable cell (denominator 0) — excluded from the mean |
| `harness_error` | never produced a gradeable artifact: pre-flight / OIDC / scaffold, or a cancellation — excluded from the mean |

**Judge dimensions.** A fixed set of five shared dimensions
(`functional_completeness`, `selector_contract`, `persistence`, `code_quality`,
`blocks_fidelity`), applied uniformly to every task with no per-task dimension,
all 0–10, **averaged equally** (no weights — they invite anchoring bias). The
overall is recomputed
deterministically from the dimensions, never read from free text. Objective
signals (build, dev-server) are applied as deterministic **hard caps**
*after* the judge returns and are never shown to the model; the test pass-rate
is recorded for audit but caps no judge dimension. A *scaffold* failure is not a
judge cap — it fails step 1 (`1-init`), so the cell becomes a `harness_error`
(excluded from the mean) before the judge ever runs.

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
snapshot). Playwright is pinned to `1.60.0`. A run-stable `RUN_ID` seeds the
specs' unique-but-deterministic data so in-process retries don't collide.

**Re-derivability.** Each `result.json` publishes `tests_passed`/`tests_total`,
`test_rate`, the raw per-dimension judge scores (pre-cap `judge_dimensions_raw`
and post-cap `judge_dimensions`), `judge_overall`, `composite`, `verdict` and
`klass`; the summary also renders a collapsible **Raw per-dimension scores**
table. A reader can re-derive — or re-weight — every composite from the
published data without re-running anything.

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

**PR-vs-baseline overview.** Each run writes a compact **aggregate** (per-cell
composites + mean) to S3 at `bench/runs/<sha>/results.json`; a push-to-`main` run
also updates `bench/runs/latest-main.json`. On a PR the summary job fetches the
baseline for the PR's **base** commit (falling back to `latest-main`) and renders,
at the **top** of the run summary, an at-a-glance per-cell composite **delta**
(▲ better · ▼ worse · = unchanged · 🆕 new) plus the overall mean delta. With no
baseline found it shows absolute composites and a "no baseline" note (never an
error). Reading/writing the baseline uses the same OIDC role
(`s3:GetObject` / `s3:PutObject` on `bench/*`); a missing grant just degrades to
"no baseline".

## Files

`steps/` mirrors the workflow 1:1 — `ls` shows the pipeline.

| File | Purpose |
|------|---------|
| `prompts.ts` | Builder + judge system prompts; the fixed shared rubric dimensions + rubric composer |
| `steps/0-init-result.mjs` | Write a baseline `result.json` so failed cells still produce an artifact |
| `steps/1-init-bench-app.sh` | Build packages, pack the local registry, scaffold the app, start the dev server, write `/tmp/dev.port` + `DEV_PORT` |
| `steps/2-agent-run.ts` | Builder agent (Strands + Bedrock); `shell` tool only; capped at `MAX_TURNS` |
| `steps/3-build-and-test.sh` | `npm run build` + Playwright spec; writes build / dev-server / playwright / test signals to `$GITHUB_OUTPUT` |
| `steps/4-judge.ts` | Judge agent (Strands + Bedrock); `view` + `list` tools, read-only; grades on the fixed 5-dimension rubric and applies hard caps |
| `steps/lib/scoring.mjs` | **Single source of truth** for scoring: `classifyCell`, `testStats`/`testRate`, `verdict`/`verdictOf`, `composite`/`compositeBand`, `isScoredCell`. Imported by both finalize + summary |
| `steps/lib/overview.mjs` | Pure helpers for the PR-vs-baseline overview: `buildAggregate` (per-cell composites + mean), `diffAgainstBaseline`, `renderOverview`. Imported by summary |
| `steps/finalize-result.mjs` | Run with `if: always()`; stamps `status` + `failed_at` from per-step outcomes, then `klass`, `test_rate`, `verdict`, `composite` via `lib/scoring.mjs` |
| `steps/summary.mjs` | Render the PR-vs-baseline overview + scoreboard (+ collapsible raw per-dimension table, run-logs deep-link) to `$GITHUB_STEP_SUMMARY`; reads one `result.json` per cell (N=1); writes the run's aggregate (per-cell composites + mean) for the S3 baseline; optional `BENCH_MIN_SCORE` gate |
| `package.json` | Workspace metadata; `private: true` |

Failure handling: every cell starts with `0-init-result.mjs` writing a
pessimistic baseline. Each successful step augments it. `finalize-result.mjs`
runs with `if: always()` and stamps `status: scored` (all steps green),
`status: error, failed_at: <step>` (a tracked step failed), or
`failed_at: pre-oidc` (something before OIDC — e.g. `npm ci` — failed). The
upload step also runs with `if: always()`, so the cell always shows up in the
summary table — never silently missing.

The scoreboard is written to the **GitHub Actions run summary**
(`$GITHUB_STEP_SUMMARY`) and renders in the run UI, with the PR-vs-baseline
overview prepended at the top. The bench posts **no PR comment** — the
github-script commenting step in `agent-bench.yml` is intentionally left in place
but commented out, so it can be restored if commenting is ever wanted again. When
the bench matrix produces no results, `summary.mjs` renders a benign "no results"
note and still exits 0.

## Local development

Each step is runnable directly with the right env. Example for the builder
(the workspace must already be scaffolded with its dev server running):

```bash
WORKSPACE=/tmp/bench-app \
TEMPLATE=demo \
TASK_PROMPT=tasks/auth-notes/PROMPT.md \
OUTPUT=/tmp/builder-result.json \
  npx tsx scripts/agent-bench/steps/2-agent-run.ts
```
