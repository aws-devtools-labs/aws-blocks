# Agent Bench

Per-PR LLM-agent benchmark. For each (task, template) cell, a builder agent
implements the task's `PROMPT.md` in a pre-scaffolded app, the build runs,
Playwright grades the result, and a judge agent scores against the rubric.

## Run it

The bench runs in GitHub Actions. Two workflows hold it:

| Workflow | Holds |
|----------|-------|
| [`pr-agent-bench.yml`](../../.github/workflows/pr-agent-bench.yml) | The triggers, the path filter, the same-repo gate and the caller token permissions. It calls `agent-bench.yml`. |
| [`agent-bench.yml`](../../.github/workflows/agent-bench.yml) | The jobs: `build-blocks`, the `bench` matrix of (task, template) cells, `summary`, and `selfcheck`. |

- **Automatic runs:** a same-repo pull request (opened / synchronized /
  reopened) or a push to `main` that changes `packages/**`,
  `scripts/agent-bench/**`, `tasks/**`, `package.json` or `package-lock.json`.
- **Manual runs:** `workflow_dispatch` on `pr-agent-bench.yml`. A change to the
  matrix in `agent-bench.yml` does not trigger a run; dispatch one:

  ```bash
  gh workflow run pr-agent-bench.yml --ref <branch>
  ```

- **Harness type-check and unit tests** (the `selfcheck` job):

  ```bash
  npm run test:ci -w scripts/agent-bench
  ```

Each step also runs directly with the right env. Example for the builder
(the workspace must already be scaffolded; no dev server is needed):

```bash
WORKSPACE=/tmp/bench-app \
TASK_PROMPT=tasks/auth-notes/PROMPT.md \
OUTPUT=/tmp/builder-result.json \
  npx tsx scripts/agent-bench/steps/2-agent-run.ts
```

The agent phases need the isolated user: create it as the workflow does
(`sudo useradd -m benchagent`, passwordless `sudo runuser` for your user) or
point `BENCH_AGENT_USER` at another unprivileged account.

### Configuration

| Variable | Set in | Effect |
|----------|--------|--------|
| `BENCH_ROLE_ARN` | `agent-bench` environment secret | The OIDC role the `bench` and `summary` jobs assume (see *Security*). |
| `BENCH_BUCKET` | `agent-bench` environment variable | The bucket that holds per-cell results and the baseline. |
| `BENCH_MODEL` | `bench` job `env` in `agent-bench.yml` | Builder model id. Default `us.anthropic.claude-opus-4-8`. |
| `BENCH_JUDGE_MODEL` | `bench` job `env` and `summary` roll-up step in `agent-bench.yml` | Default `us.anthropic.claude-opus-4-8` in each location. Set both so judging and roll-up analysis use the same judge model. Use a different id from `BENCH_MODEL` to limit same-model self-evaluation bias. |
| `BENCH_MIN_SCORE`, `BENCH_MAX_REGRESSION`, `BENCH_MAX_HARNESS_ERRORS` | repo/org variables | Optional thresholds. An upstream failure with no artifacts can still fail the summary (see *Gating*). |
| `BLOCKS_TELEMETRY_CANARY_ID` | workflow secret | Optional. Step 1 seeds the telemetry canary from it; unset skips the seed with a warning. |
| `BENCH_AGENT_USER` | local env | The unprivileged account agent code runs as. Default `benchagent`. |
| `BENCH_ALLOW_BARE_SHELL` | local env | `1` runs the agent's commands as your own user, so the agent can read your environment. Refused whenever `CI` or `GITHUB_ACTIONS` is set. |

## Architecture

Ten steps per cell, all on the GitHub runner. 4b and 6b are best-effort auxiliaries; 4c fails closed and gates uploads.
The runner is the sandbox; Bedrock provides the model.

0. **Init result.** Writes a baseline `result.json` before any AWS call, so
   even an OIDC failure still produces a cell row in the summary.
1. **Init.** Builds the local registry and scaffolds a fresh app. No dev server
   starts here: the verifier (step 3) launches it, so the agent's edit phase
   runs with nothing bound.
2. **Agent run.** Strands + Bedrock. The agent has the framework's vended
   `bash` + `fileEditor` tools, both routed through a `WORKSPACE`-rooted Sandbox
   (`steps/lib/run-shell.ts`) whose shell runs as the unprivileged `benchagent` user
   with a credential-free env (see *Security*). The agent must not rely on or
   start a dev server.
3. **Build and test.** The script is a trusted supervisor; every process that
   runs the agent's app or its dependencies runs as `benchagent` (see
   *Security*). It:
   - runs `npm run build`;
   - launches the dev server fresh;
   - reads the port from the framework's startup banner
     (`AWS CDK Blocks local server running on http://localhost:<port>`) and exports
     it as `APP_BASE_URL`;
   - runs the task's Playwright spec against it;
   - records build / dev-server / playwright / test signals.
4. **Judge.** Strands + Bedrock; one vended `bash` tool rooted at a
   spec-blinded, disposable source-only copy of the workspace.
   Its shell runs as the credential-free `benchagent` user, like the builder's.
   Writes it makes to the copy can't affect scoring.
   Scores source only; objective signals are applied as caps afterward, not
   shown to it.
   - **4b. Analyze cell** (best-effort). Asks the judge model for a
     2–4 sentence analysis of this cell's fresh `trace.json` + `metrics.json`
     plus a short list of potential issues, and writes both back into
     `result.json` as `analysis` + `analysis_issues[]` (`analyze-cell.mjs`). The
     summary job later rolls these up.
   - **4c. Stage artifacts.** Reaps every `benchagent` process, then builds the
     only copy that gets published: redacted `result.json`, trace, metrics,
     command log and generated source in a runner-only dir
     (`stage-artifacts.mjs`; see *Security*). Steps 5–6b and the S3 persist read
     only that copy and run only if this step succeeded.
5. **Upload result.** JSON artifact + S3 archive (best-effort).
6. **Upload source.** Uploads the staged `bench-app` copy as
   `bench-source-<task>-<template>` for post-run auditing. Dependencies, build
   output, VCS data and anything credential-shaped (`node_modules`, `.git`,
   `dist`, `.cdk-blocks-sandbox`, `.env*`, `*.pem`, `.aws`) are never staged.
   - **6b. Upload trace** (best-effort). The agent trace, run metrics and
     command log written by step 2. On a wall-clock timeout step 2 emits no
     trace, so nothing uploads.

## Security

The builder (`2. Agent run`) and the judge (`4. Judge`) run LLM-driven agents
with a shell, and step 3 runs the code the builder wrote. A prompt-injected or
otherwise malicious task `PROMPT.md`, or agent-written source the judge reads,
could try to use or leak the job's credentials:

- the Bedrock-scoped AWS session;
- the `ACTIONS_ID_TOKEN_REQUEST_*` pair, which mints a fresh OIDC token and
  could assume the role *without* the session policy;
- the runner's own tokens.

The boundary, outermost first:

1. **Who can trigger.** The matrix runs only on the same repo (triggers: see
   *Run it*). The same-repo guard is enforced in
   [`pr-agent-bench.yml`](../../.github/workflows/pr-agent-bench.yml): fork PRs
   get no secrets or OIDC under `pull_request`, so an external contributor
   cannot reach the role through this workflow. The guard checks repository identity,
   not review status: same-repo runs trust the harness and prompts at the selected revision.
2. **Bedrock-only AWS session.**
   - The bench job's `Configure AWS credentials` step passes an inline session
     policy. The session every step up to the uploads runs with can only call
     `bedrock:InvokeModelWithResponseStream` and `bedrock:Converse` on
     model-invocation ARNs (the effective permissions are the intersection of
     the role and that policy).
   - The S3 write returns only by re-assuming the role without the policy
     right before `Persist to S3`: after every agent, analysis and upload step,
     only if step 4c succeeded (so after every agent process has been killed),
     and never on a cancelled run.
   - The `summary` job holds the full role but runs no agent code.
   - The role is `blocks-github-bench` in E2E account 1
     ([`test-infra/github-oidc-stack.ts`](../../test-infra/github-oidc-stack.ts)):
     Bedrock model invocation, `s3:GetObject`/`s3:PutObject` on `bench/*`, and
     `s3:ListBucket` conditioned on the `bench/*` prefix.
   - Both jobs run in the `agent-bench` GitHub environment, and the role trusts
     only that environment's OIDC `sub`, so a token minted in a bench job can
     assume this role and no other. That trust policy, not the role's
     permissions, is the outer bound on what the job's OIDC token can reach.
3. **A separate uid for all agent code, fail closed** (`steps/lib/isolation.mjs`).
   - The harness processes keep the job env: the builder/judge model calls run
     in the harness (Strands `BedrockModel`) and the analysis calls run the
     `aws` CLI from the harness.
   - Everything the agent controls runs as `benchagent`, an unprivileged user
     with no sudo rights, via `sudo -n runuser`: the builder and judge shells
     (`steps/lib/run-shell.ts`) and, in step 3, every process of the agent's
     app, started through `steps/lib/agent-exec.mjs`. Those processes are the
     `package.json` probes, `npm install` and its lifecycle scripts, the build,
     the dev server and Playwright (it loads the app's `node_modules`).
   - A different uid can't read the harness's `/proc/<pid>/environ` or signal
     it.
   - Step 3's script is the trusted supervisor: it opens the log redirects
     itself (runner-owned files), reads agent-written files without following
     links, and alone writes `GITHUB_OUTPUT`, from validated integers.
   - Under CI (`CI` or `GITHUB_ACTIONS` set) there is no same-uid fallback: if
     `benchagent`, the workspace ACL or the checks below fail, the phase
     refuses to run and records `isolation_failure`, which scores as
     `harness_error` (infra).
   - A bare shell exists only for local development, behind
     `BENCH_ALLOW_BARE_SHELL=1`.
4. **Runner temp locked and verified.** The runner's file-command files
   (`GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, …, including the env file
   `configure-aws-credentials` writes the AWS keys to) live in `RUNNER_TEMP`.
   Before any agent code runs, each phase makes `RUNNER_TEMP` and the
   file-command dirs `0700`, then checks as `benchagent` that it can't list or
   read any of them, nor read any runner-uid `/proc/<pid>/environ`; a failure
   is an `isolation_failure`. Writing those files would otherwise inject env or
   `PATH` into later steps, including the one that re-assumes the full role.
5. **Trusted executables locked and verified.** Later runner-uid steps, and
   `sudo` as root through its `secure_path`, execute from these paths:
   - the runner `PATH`;
   - `/usr/local/{s,}bin` and the other system dirs;
   - the node install;
   - the hosted tool cache;
   - global npm modules;
   - the checkout (its `scripts/agent-bench` and `node_modules`);
   - the downloaded actions and the runner itself.

   The hosted image ships some of these world-writable (e.g. `/usr/local/bin`,
   `/opt/hostedtoolcache`), which would let the agent plant or replace a binary
   that a later step runs with the credentials.
   - Before any agent code runs, each phase removes group/other write from
     every such path `benchagent` can write (via `sudo`, under CI).
   - It then checks as `benchagent` that it can't write or replace any of
     them, any entry in them, or any (non-sticky) ancestor. Anything left (e.g.
     a file it already owns) is an `isolation_failure`.
   - The agent's own dirs (the workspace, the Playwright browser cache, which
     no runner-uid process executes from afterwards) are excluded.
   - The harness's own tool calls (`sudo`, `runuser`, `pkill`, …) use absolute
     system paths.
6. **Reap.** Every `benchagent` process (setsid/nohup escapees included) is
   killed and its crontab removed at the start and end of each agent phase, and
   step 4c reaps and verifies none remain before anything is published or the
   role is re-assumed.
7. **Credential-free env.** Each agent process gets an explicit env from
   `buildShellEnv` (`steps/lib/secrets.mjs`); per-command overrides pass the same
   filter, so they can add app settings (`BLOCKS_URL`, `RUN_ID`, …) but never
   reintroduce anything denied:
   - **allowed:** `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
     `HOSTNAME`, locale (`LANG`, `LANGUAGE`, `TZ`, `LC_*`), terminal (`TERM`,
     `COLORTERM`, `FORCE_COLOR`, `NO_COLOR`), `XDG_*` dirs, CI markers (`CI`,
     `GITHUB_ACTIONS`, `RUNNER_OS`, `RUNNER_ARCH`), node/TLS/proxy (`NODE_OPTIONS`,
     `NODE_ENV`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`DIR`, `HTTP(S)_PROXY`,
     `NO_PROXY`, `ALL_PROXY`), `AWS_REGION`/`AWS_DEFAULT_REGION`, the framework's
     `CDK_DISABLE_CLI_TELEMETRY`, `WORKSPACE`, and the `NPM_CONFIG_*`/
     `npm_config_*`, `PLAYWRIGHT_*` and `BLOCKS_*` prefixes. `PATH` keeps only
     system dirs and the harness's own node dir (both covered by the lockdown);
     `NODE_OPTIONS` keeps only flags that load no code.
   - **always stripped:** every other `AWS_*` (keys, session token, profile,
     web-identity, container-credential and config-file vars), every `ACTIONS_*`,
     `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, any name
     containing `TOKEN`, `SECRET`, `PASSW`, `KEY`, `CREDENTIAL` or `AUTH`, every
     other `GITHUB_*` / `RUNNER_*` (file commands, `RUNNER_TEMP`), and startup
     hooks (`BASH_ENV`, `ENV`, exported bash functions, `PROMPT_COMMAND`,
     `LD_*`, npm's `node-options`/`script-shell`/config-file redirects).
8. **Redaction, then a fail-closed published copy.**
   - **Writers redact before writing:** `commands.jsonl` (command, cwd, stdout,
     stderr; redacted before the 4000-char cut), `trace.json`, `metrics.json`,
     `result.json`, the summary job's step summary, PR comment, S3 aggregate,
     Athena NDJSON and `bench-analysis.json`, and every analysis prompt (trace
     values are redacted before serialization).
   - **Step 4c builds the only copy that is published,** in a runner-only dir.
     Harness files must be regular files owned by the runner, opened without
     following links. The source root and its ancestors must contain no
     symlink.
   - **Step 4c drops, and never publishes:** symlinks, special files, binaries
     (NUL / invalid UTF-8), files over 20 MiB, unreadable files and entries
     whose name carries a credential or control character.
   - **Harness JSON** (result, trace, metrics, command log) is redacted value
     by value and key-aware: a string under a credential field name
     (`SecretAccessKey`, `SessionToken`, `password`, `apiKey`, `authorization`,
     env-style `*_TOKEN`, …; exact names, not substrings) is replaced whatever
     its format, and numeric usage fields survive.
   - **Source files the agent wrote,** JSON included, are redacted by value
     only, so `package.json` scripts and lockfile package names
     (`credential-provider-*`, `js-cookie`, …) stay byte-identical.
   - **The redactor replaces:** the exact values of the credential vars in the
     harness env, AWS key ids (`AKIA`/`ASIA`), STS session tokens, JWTs (e.g.
     OIDC tokens), GitHub (`ghp_`/`ghs_`/…, `github_pat_`) and npm tokens, PEM
     private keys and, in logs but not source, credential-named `NAME=value`
     pairs.
   - **If 4c fails,** nothing from that cell is uploaded or persisted (it is
     then missing from the summary table); the scoring itself is unchanged.

### Limits

- The boundary is a uid on a shared VM, not a container: `benchagent` can
  still read whatever is world-readable on the runner outside `RUNNER_TEMP`.
- `benchagent` shares the network. The bench assumes a GitHub-hosted runner; on
  an EC2 self-hosted runner the instance metadata service would hand out the
  instance role to any process.
- Allowed env values such as a proxy URL pass through to the agent and are not
  redaction sources.
- The agent's code produces the Playwright report the supervisor scores
  (validated as bounded integers), so score integrity depends on that code
  reporting honestly.
- Redaction is best-effort: it cannot catch a secret that was encoded, split
  or otherwise transformed, or a credential in an unknown format without a
  credential-like name next to it. In source files, only exact values and
  known token formats are caught.
- Dropped binary and oversized files are missing from the source artifact.
- Job logs are not passed through this redactor (GitHub masks the secrets it
  knows about), and the agent never holds credentials to print.

## Tasks

Each task is a directory under `tasks/` with a `PROMPT.md` and a
`test.spec.ts` (see [`tasks/README.md`](../../tasks/README.md)).

- `PROMPT.md` is given to the builder. It holds the task objective and the
  selector contract only, no framework how-to; the agent learns the framework
  from the scaffolded app's own `README.md`.
- `test.spec.ts` is the graded Playwright spec. It is never shown to the
  builder or the judge.
- A task has no rubric of its own: the judge scores every task on the shared
  dimensions (see *Judge dimensions*).

| Task | Template | Blocks exercised |
|------|----------|------------------|
| `auth-notes` | `demo` | Auth (email + password, emailed sign-up code) + KVStore |
| `file-gallery` | `bare` | FileBucket |
| `async-word-counter` | `bare` | AsyncJob + KVStore |
| `collab-presence-board` | `default` | Realtime + KVStore (schema + key) |
| `cognito-profile` | `auth` | Auth (email + password sign-up confirmed with an emailed code; profile + session) |
| `observability-api` | `backend` | Logger + Metrics + Tracer + AppSetting |
| `sql-kb-catalog` | `nextjs` | Database + KnowledgeBase |
| `oidc-dsql-notes` | `react` | Auth (`store: 'builtin'`, stub IdP) + Database (Aurora DSQL) |
| `email-digest` | `demo` | CronJob + EmailClient + KVStore |
| `kb-chat-agent` | `demo` | Agent (Bedrock Sonnet 4.6) + KnowledgeBase + tool use |

These 10 cells cover 14 Building Blocks across 7 templates. The matrix is the
`include:` list of the `bench` job in `agent-bench.yml`: explicit
(task, template) pairs, not a cross-product. Each task runs on the single
template that pre-ships (or best exercises) its blocks, to bound Bedrock
spend. To add a cell, add the task directory and one `include:` entry. The
`task` name is part of
`result.json`, the artifact name (`bench-result-<task>-<template>`) and the S3
key, so cells never collide.

## Scoring

The formulas, the verdict tiers and the exclusion rule live in
[`steps/lib/scoring.mjs`](steps/lib/scoring.mjs). `finalize-result.mjs` stamps
them onto every `result.json` and `summary.mjs` renders them, both from that
one module.

### Composite (0–100), per cell

```
tr        = tests_passed / (tests_passed + tests_failed)   # 0 if no tests ran
judge     = overall judge score, 0–10 (0 if the judge errored)
composite = round( 60*tr + 4*judge*min(1, 4*tr) , 1 )
```

- 60% is the objective pass-rate, 40% is the judge.
- A cell with zero passing tests scores 0 whatever the judge said.
- The judge term reaches full weight once ≥25% of tests pass (`min(1, 4*tr)`).
- A judge failure (`judge=0`) drops only the judge's 40%.
- Bands: ≥80 🟢, ≥50 🟡, else 🔴.

### Cost and score, per cell

- COST is the builder's token spend priced at Bedrock Claude Opus 4.8 rates:
  `$5` / 1M input, `$25` / 1M output. Edit `PRICING` / `BUILDER_PRICING` in
  `steps/lib/scoring.mjs` when AWS pricing or the builder model changes.
- Judge and analysis spend is not counted.
- SCORE = `composite ÷ cost`: composite points per dollar, higher is better.
- A composite 0 cell scores 0 whatever it cost.
- A cell with no recorded tokens renders `—`, not `$0`.
- Set the `SCORE_PER_DOLLAR` constant in `steps/lib/scoring.mjs` to `false`
  for cost-per-point instead.

### Indicators vs baseline, per metric

In the report every metric cell shows its current value with a signed delta
vs the baseline value for that metric. The emoji marks the significance and
direction of the change, not absolute quality:

| Indicator | Meaning |
|-----------|---------|
| ✨ | noticeably improved (beyond 1× threshold) |
| ✅ | no significant change (within the noise band; N=1) |
| ⚠️ | slight regression (beyond 1× threshold) |
| ❌ | serious regression (beyond 2× threshold) |
| 🆕 | no baseline value for that field (a new cell, or a metric the baseline predates); the current value is still shown, tagged `(new)` |
| `—` | nothing to show this run |
| 🗑️ | cell gone since the baseline |

The noise bands are `DELTA_THRESHOLDS` in `steps/lib/overview.mjs`, consumed
by `deltaColor`:

| Metric | Better | Band |
|--------|--------|------|
| composite | higher | ±5 points |
| score | higher | ±5 points |
| judge | higher | ±0.3 |
| tests | higher | ±1 pass |
| cost | lower | ±10% (relative, floor $0.02) |
| turns | lower | ±3 |

### Verdict tiers

Verdict tiers are pure pass-rate. The judge plays no part, so an LLM
failure can never flip a verdict:

| Verdict | Condition |
|---------|-----------|
| `pass` | pass-rate ≥ 0.999 |
| `partial` | 0 < pass-rate < 0.999 |
| `fail` | pass-rate == 0 with tests that ran, **or** an agent failure (the builder timed out / produced no app at `2-agent`) — scored as composite 0 |
| `unknown` | no tests ran on an otherwise-gradeable cell (denominator 0) — excluded from the mean |
| `harness_error` | never produced a gradeable artifact: pre-flight / OIDC / scaffold, or a cancellation — excluded from the mean |

`isScoredCell()` in `steps/lib/scoring.mjs` decides which cells enter the
headline mean. Excluded cells are reported separately. An agent failure is
included in the mean as composite 0.

### Judge dimensions

- `COMMON_DIMENSIONS` in `steps/lib/scoring.mjs` defines the dimensions:
  `functional_completeness`, `selector_contract`, `persistence`,
  `code_quality`, `blocks_fidelity`.
- Every task is scored on all of them, 0–10 each, averaged with equal weight.
- The overall is recomputed from the dimensions, never read from free text.
- Objective signals (build, dev-server) are applied as hard caps after the
  judge returns and are never shown to the model.
- The test pass-rate is recorded for audit but caps no judge dimension.

### Spec-blinding

The judge grades a source-only copy of the workspace. The copy excludes
`bench-tests/` (where step 3 stages the spec) and every
`*.spec.{ts,tsx,js,jsx,cjs,mjs}` code file. A post-copy `find`
(`assertNoSpecLeak` in `steps/4-judge.ts`) fails the step if one is present.
Framework-generated `*.spec.json` manifests (e.g. `cdk-blocks/blocks.spec.json`,
the OpenRPC contract) stay in the copy: they are build artifacts, not the
bench objective.

### Reps

The bench runs N=1: one rep per cell. Each cell produces one `result.json`,
and the summary scores it directly.

### Reproducibility pins

- The builder sets `temperature=0` only for models that accept it (e.g.
  Sonnet). Opus 4.8 rejects `temperature`, so the builder and the judge omit
  it there.
- Model IDs are pinned snapshots (the Claude 4.x IDs carry no date suffix).
- Playwright is pinned to `1.64.1` and runs with `retries: 0`: a retry would
  mask realtime-propagation flake.
- A run-stable `RUN_ID` seeds the specs' unique-but-deterministic data, so
  identifiers stay collision-free across a spec's internal navigation.

### Published fields

Each `result.json` publishes `tests_passed`/`tests_total`,
`test_rate`, the raw per-dimension judge scores (pre-cap `judge_dimensions_raw`
and post-cap `judge_dimensions`), `judge_overall`, `composite`, `verdict`,
`klass`, the builder `tokens_in`/`tokens_out`, and `stop_reason`. The results
table renders the overall judge score, tests, cost, turns and score per cell.
Cost and score are derived from the published tokens via `steps/lib/scoring.mjs`.

### Gating

The summary reports scores without enforcing a floor or regression limit by default.
Set any of these repo/org variables to enforce its threshold:

- `BENCH_MIN_SCORE`: absolute floor. Fails when the mean composite across scored
  cells falls below it. Skipped (never fails) when no cell scored.
- `BENCH_MAX_REGRESSION`: regression vs `main`. Fails when the mean composite
  drops more than this many points below the `main` baseline. Skipped when no
  baseline exists.
- `BENCH_MAX_HARNESS_ERRORS`: infra-failure ceiling. Fails when more than this
  many cells are `harness_error`. An unreadable or corrupt `result.json`
  artifact counts as one. Must be a whole number.
- Always on: if `build-blocks` or the bench matrix fails and produces zero
  result artifacts, the summary fails even without thresholds. A skipped or
  cancelled job alone does not trigger this rule.

A negative or non-numeric value for any gate variable is treated as unset, as
is a fractional `BENCH_MAX_HARNESS_ERRORS`. The
PR-vs-baseline results table is observational; the regression gate
(`BENCH_MAX_REGRESSION`), not the table's ±5-pt display band, is what blocks.

### Check status

Cell scores are advisory unless a summary threshold applies. Workflow failures are separate:

- The grading steps (`npm ci`, OIDC, `1-init`, `2-agent`,
  `3-build-and-test`, `4-judge`) use `continue-on-error: true`, paired with an
  `if: steps.<prev>.outcome == 'success'` chain, so a failed step skips the
  later ones. An agent timeout skips tests and judge and scores composite 0,
  rather than scoring a partial app.
- A graded cell's outcome lives in `result.json` and the run summary. Mandatory
  preflight checks, such as verifying the isolation user has no sudo rights, can fail the job.
- A new commit cancels the prior in-flight run via the workflow `concurrency`
  group.

### The report

- Each run writes a compact aggregate (per cell: composite/verdict, test
  counts, per-dimension judge scores, builder tokens, cost, and score-per-$,
  plus the mean) to S3 at `bench/runs/<sha>/results.json`.
- A push-to-`main` run also updates the stable pointer
  `bench/runs/latest-main.json`.
- The summary job fetches a baseline and renders one results table
  (`renderDetailed` in `steps/lib/overview.mjs`):
  `TASK · TEMPLATE · TESTS · JUDGE · COST · TURNS · SCORE · STOP REASON`.
- Each metric cell is one line, `<indicator> <value> (<Δ vs main>)`, with the
  indicators above.
- The JUDGE cell shows the overall judge score; the per-dimension breakdown
  lives in the judge artifact JSON.

Report layout, top to bottom:

1. A collapsible Glossary (scoring, colors, the per-metric thresholds).
2. The deterministic headline (mean composite + delta).
3. The results table.
4. From the best-effort roll-up step (`analyze.mjs`): an Executive summary (a
   short paragraph + bullets), a Potential issues section (fed by each cell's
   own analysis), and a collapsed Per-cell analysis (each cell also collapsed
   within it).

The report is written to the GitHub Actions run summary
(`$GITHUB_STEP_SUMMARY`) and posted as one sticky PR comment:

- The `Comment bench report on PR` step upserts a single comment keyed by a
  hidden `<!-- agent-bench-report -->` marker (`steps/lib/pr-comment.sh`).
- It runs on same-repo PRs only (a fork PR has no token) and is
  `continue-on-error`, so a comment failure never fails the bench.
- It requires `pull-requests: write`, granted on the caller `bench` job in
  `pr-agent-bench.yml` (a reusable workflow's token is capped down to the
  caller's).

With no results, the summary can still fail if an upstream job failed (see *Gating*).

### Baseline selection

- A PR diffs against `bench/runs/latest-main.json`, the most recent
  `main`-branch bench, not the PR's recorded base commit.
  `github.event.pull_request.base.sha` goes stale as `main` advances and can
  point at a commit that was never benched.
- A push to `main` diffs against the immediately preceding main commit
  (`github.event.before`) by exact sha, with `latest-main` as the fallback.
- With no baseline found the table shows current values only (every metric
  `🆕 (new)`) and a "no baseline" note; it is not an error.
- Reading and writing the baseline uses the same OIDC role (`s3:GetObject` /
  `s3:PutObject` on `bench/*`); a missing grant degrades to "no baseline".

## Files

The numbered scripts in `steps/` are the workflow's numbered steps. The
`steps/lib/*.test.mjs` files are the unit tests `npm run test:ci` runs.

| File | Purpose |
|------|---------|
| `prompts.ts` | Builder + judge system prompts; the fixed shared rubric dimensions + rubric composer |
| `steps/0-init-result.mjs` | Write a baseline `result.json` so failed cells still produce an artifact |
| `steps/1-init-bench-app.sh` | Build packages, pack the local registry, scaffold the app, seed the telemetry canary from `BLOCKS_TELEMETRY_CANARY_ID` |
| `steps/install-chromium-shim.sh` | Wrap the system and Playwright chromium binaries with the flags that let the agent's own headless launches start on the runner |
| `steps/2-agent-run.ts` | Builder agent (Strands + Bedrock); vended `bash` + `fileEditor` tools; capped at `MAX_TURNS` |
| `steps/3-build-and-test.sh` | Trusted supervisor: `npm run build` + Playwright spec, every app/dependency process run as `benchagent` via `steps/lib/agent-exec.mjs`; validates and writes build / dev-server / playwright / test signals to `$GITHUB_OUTPUT` |
| `steps/4-judge.ts` | Judge agent (Strands + Bedrock); one vended `bash` tool over a spec-blinded, disposable source-only copy; grades on the fixed shared rubric (`COMMON_DIMENSIONS`) and applies hard caps |
| `steps/lib/run-shell.ts` | Shared shell infrastructure for the builder + judge: the `WorkspaceSandbox` (host-execution Sandbox rooted at a fixed dir) + a backgrounded-process-safe runner that spawns every command as `benchagent` with the `buildShellEnv` env and writes the redacted `commands.jsonl`. Imported by `2-agent-run.ts` and `4-judge.ts` |
| `steps/lib/isolation.mjs` | The agent-user boundary: the `runuser` spawn (refuses a same-uid fallback under CI), workspace ACL, trusted-executable lockdown + runner-temp lockdown (each verified as the agent user), the reap, and `enterAgentPhase` |
| `steps/lib/agent-exec.mjs` | Step 3's bridge to that boundary: `preflight`, `run` (a command as `benchagent`), `reap`, and `read-file` (copy an agent-written file without following links) |
| `steps/lib/secrets.mjs` | Credential hygiene: `buildShellEnv` (the env policy for agent processes), `redactSecrets` / `redactDeep` (key-aware) / `stringifyRedacted` / `createRedactor` (artifact, sink and prompt redaction). Pure apart from `redactSecrets` reading `process.env` |
| `steps/lib/bedrock-retry.mjs`, `steps/lib/bedrock-retry.ts` | Retry and backoff for the builder's and the judge's Bedrock calls when the account is throttled; the `.ts` file is a typed re-export |
| `steps/lib/partial-envelope.mjs` | The builder's checkpoint envelope, written every model cycle so an abrupt kill still leaves token spend on disk |
| `steps/lib/workspace-diff.mjs` | Best-effort lines/files churn for a cell: snapshots the scaffolded workspace before the agent runs and diffs it afterwards, in a throwaway git dir outside the workspace |
| `steps/stage-artifacts.mjs` | Step 4c: reap, then build the only published copy (redacted harness files + source, no links/binaries/oversized/unreadable files or credential-bearing names); fails closed |
| `steps/lib/scoring.mjs` | Scoring: `classifyCell`, `testStats`/`testRate`, `verdict`/`verdictOf`, `composite`/`compositeBand`, `isScoredCell`, plus the cost/score model: `PRICING`/`BUILDER_PRICING`, `cellCost`, `scorePerDollar` (+ the `SCORE_PER_DOLLAR` knob). Imported by finalize, summary, and overview |
| `steps/lib/overview.mjs` | Pure helpers for the report table: `buildAggregate` (schema-2 aggregate: per-cell composite/tests/judge-dims/tokens/cost/score/stop_reason + mean), `diffAgainstBaseline`, the color engine (`DELTA_THRESHOLDS`, `deltaColor`), formatters, and `renderDetailed` (the results table). Imported by summary + analyze |
| `steps/lib/analysis.mjs` | Shared, mostly-pure helpers for the trace/metrics analysis feature: trace trimming, prompt builders, and `parseCellAnalysis` (splits the per-cell model output into an analysis string + a bounded potential-issues list). Imported by `analyze-cell.mjs` (per-cell) and `analyze.mjs` (roll-up) |
| `steps/analyze-cell.mjs` | Step 4b: per-cell trace/metrics analysis via the judge model; writes `analysis` and `analysis_issues[]` into the cell's `result.json` |
| `steps/analyze.mjs` | Summary-job roll-up: synthesizes the per-cell analyses into the Executive summary via one best-effort Bedrock call, aggregates the Potential issues section, and renders the collapsed Per-cell analysis |
| `steps/lib/gates.mjs` | The merge gate: `parseThreshold` + `evaluateGates` decide pass/fail from the floor (`BENCH_MIN_SCORE`), regression-vs-`main` (`BENCH_MAX_REGRESSION`) and harness/infra (`BENCH_MAX_HARNESS_ERRORS`, incl. the whole-run upstream-failure case). Pure; imported by summary |
| `steps/lib/pr-comment.sh` | Upsert the report as one sticky PR comment keyed by a hidden marker (update oldest, delete duplicates); same-repo PR only, best-effort |
| `steps/lib/s3-put.sh` | Best-effort `aws s3 cp` for the persist steps: warns, never errors, on a missing source or a failed copy |
| `steps/finalize-result.mjs` | Run with `if: always()`; stamps `status` + `failed_at` from per-step outcomes, then `klass`, `test_rate`, `verdict`, `composite` via `steps/lib/scoring.mjs` |
| `steps/summary.mjs` | Renders the report to `$GITHUB_STEP_SUMMARY` and to a file for the sticky PR comment, including a Merge verdict section (each enabled gate's decision) and a deterministic caveats block. Reads one `result.json` per cell. Writes the run's schema-2 aggregate (+ Athena NDJSON) for the S3 baseline. Runs the three gates via `steps/lib/gates.mjs` and exits non-zero when any trips |
| `package.json` | Workspace metadata; `private: true` |

Failure handling: each successful step augments the baseline `result.json`
that step 0 wrote. `finalize-result.mjs` stamps `status: scored` when all tracked
steps succeed. A failed or cancelled tracked step gets `status: error` or
`status: cancelled` and its name in `failed_at`. An earlier failure such as
`npm ci` gets `status: error, failed_at: pre-oidc`. The
upload step runs whenever step 4c staged the cell (`if: always()` plus the
staging gate), so the cell shows up in the summary table unless its files could
not be safely staged.
