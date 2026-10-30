# Harbor agent check

An opt-in, **non-required** GitHub Actions check for AWS Blocks PRs. It packs the PR head and
its merge-base, then asks Claude Code to create a todo app, add due dates and add labels in one
resumed session per trial. The default is one trial per arm (**n=1**): that report is
descriptive, not a statistical claim. More trials give pass-rate intervals and metric
differences with uncertainty (see [Trials and statistics](#trials-and-statistics)). Nothing is
deployed.

## What runs

`.github/workflows/harbor-agent-check.yml`, dispatched from `main` for an open PR:

1. Resolve the PR head and its merge-base with the PR base SHA.
2. On credential-free runners, `npm ci`, `npm run build` and `npm run publish:local` at both commits.
3. After one blocks-team approval of the `approval` job (environment `harbor-bench-approval`), each
   (arm, trial) matrix job runs in the `harbor-bench` environment: `prepare.py` builds one task with
   harness code from the workflow SHA and that arm's packed registry, and `run.py` runs Harbor with a
   dedicated Bedrock-only role.
4. Harbor sends the three `task/steps/*/instruction.md` prompts to one Claude Code session.
   Subagent and web tools are disabled.
5. After each phase the root-owned verifier (`task/tests/verify.py`) kills agent servers,
   saves a [phase snapshot](#phase-snapshots), checks package provenance, runs `npm run build`,
   starts `npm run dev` as `node` and drives Chromium (`ui.mjs`) through every behavior added so
   far. Contract controls are located by accessible name among form fields only. It then checks
   that the records it created appear under the app's Blocks mock data directory (`.bb-data`), a
   heuristic that catches storage outside Blocks but not a backend writing its own files there.
   Finally it restarts the server and checks the records again in a fresh browser context.
6. Each trial uploads its allowlisted result as artifact `harbor-result-<arm>-<trial>` and, when
   configured, its redacted raw trace to a [private bucket](#private-traces).
7. A separate job renders `report.py` over all trials into the run summary and one advisory PR
   comment.

A phase passes only when the agent finished, same-session accounting is complete and every
verifier check passed. Failed create or due-date phases stop later phases. A failed check of
earlier records reports a fixed reason (`prior_missing`, `prior_title`, `prior_completed`,
`prior_due`, `prior_labels`), and an ambiguous contract locator reports `locator_ambiguous`.

The image's Playwright and Chromium live under `/opt/playwright`; `/opt/playwright/index.mjs`
exports them with no environment setup, for the verifier and for the agent, whose create
prompt names it. Nothing sets `PLAYWRIGHT_BROWSERS_PATH` globally, so a project's own
`playwright install` uses the user's home cache.

## Pins and skill delivery

`pins.py` holds the model (`global.anthropic.claude-opus-5-5`), Claude Code version, Harbor
revision and the public [AWS Blocks skill](https://github.com/aws/agent-toolkit-for-aws/tree/2cb0fa1c2e668e1bb075028800b6b27efb95779e/skills/core-skills/aws-blocks)
revision and SHA-256. `requirements.txt` and the workflow's session policy repeat the Harbor
revision and model ARN; change them together.

`prepare.py` downloads the pinned skill and passes it to Harbor's `skills` agent option, which
installs it into Claude Code's skills directory. The prompts never name the skill or the docs, so
the report's `skill` field (`skill_tool`, `file_read` or `none`) shows whether the installed skill
triggered. It is reported, never required.

## Package provenance

Each arm has a loopback registry (`registry.mjs`) that serves only that arm's `@aws-blocks/*`
tarballs and logs requests. Third-party packages come from public npm. `provenance.py` requires
that the scaffolder tarball was served and that every installed `@aws-blocks/*` package in the
app has the arm's lockfile version, registry URL and integrity, was served, and matches the
packed bytes. The backend must import `@aws-blocks/*` and expose an `ApiNamespace`.

Byte-identical packages in both arms make the run an **A/A infrastructure demonstration**.

## Accounting

Claude Code's result `modelUsage` and `total_cost_usd` are cumulative across `--continue`;
`accounting.py` differences them per phase. Turns and tool calls are per invocation. A session
change, missing counter or decrease stays unavailable, never zero. Rows with a failed or
incomplete phase are marked not comparable.

List-price cost (the CLI's estimate, not AWS billing) depends on whose prompt cache served a
prefix: a session that starts while another has the same prefix cached reads it instead of
writing it, and a long tool call can let a cache entry expire. The primary metric is therefore
**cache-neutral cost**: each call's context growth priced as a cache write, the rest of its
processed input as a cache read, and output at the output price, from the per-call usage in the
stream and the list prices in `pins.py`. *Input processed* (input + cache write + cache read) is
reported alongside. New input and cache read stay as descriptive columns and are not compared
across arms.

Each result also records the storage block the backend constructs (`kv_store`,
`distributed_table`, `database`, `distributed_database`, `file_bucket`, `multiple`, `none` or
`unknown`), read from the create-phase snapshot. Agents choose between blocks and the choice
changes cost, so the report shows counts and the primary metric per storage block, with a
within-block difference when both arms have at least 3 passes.

Bounds: 200 turns and 25 minutes per phase, 5 minutes per verifier, 100 minutes per Harbor
process, 110 minutes per trial job. No retries and no dollar cap.

## Trials and statistics

The `trials` dispatch input (an integer from 1 to 50, default 1, validated by `trials.py` before
approval is requested) runs an `arm × trial` benchmark matrix. Packages are still built once per
arm; every trial job prepares its own `run-<arm>-<trial>` directory and image on its own runner,
in parallel. Each trial is a separate paid session: N trials cost about N times one run, and
many concurrent sessions can hit Bedrock throttling.

`report.py results report.md --trials N` reads every `harbor-result-<arm>-<trial>/result.json`;
trials without a result or with an infrastructure error are listed and excluded from rates.
A phase counts as passed when it and every earlier phase passed with complete accounting in one
session and Harbor exited cleanly. For each arm and phase (and the whole run) it shows:

- passes/N with a Wilson 95% interval, and how the agent reached the skill;
- median and IQR of cache-neutral cost, input processed and output tokens, turns, tool calls,
  seconds and list-price cost (plus descriptive new input and cache read) over passed phases;
- candidate − baseline difference of medians with a seeded percentile bootstrap 95% interval
  (2000 resamples), or *not comparable* when either arm has fewer than 3 passes.

At n=1 the report keeps the single-trajectory table and makes no interval claims. The
statistics live in `stats.py`, shared with the [local calibration](#local-calibration) runner.

## Phase snapshots

Before any check, after the agent's processes are killed and before provenance, build, server
start or the browser exercise, `verify.py` writes `/logs/verifier/snapshot.tar.gz`
(`task/tests/snapshot.py`): `todo-app/` as the agent left it, without any `node_modules`
directory but with `.bb-data` and the lockfile, plus `verifier-state.json`, a copy of the
verifier's record list seeded by the earlier phases. Writing it first means it exists whether
the checks pass, fail or time out; a snapshot error is logged and never fails the phase. Harbor
moves each phase's `/logs/verifier` into `steps/<phase>/verifier/`, so every phase keeps its own
snapshot. Restoring one and running a phase's verifier against other packages is the planned
cross-version replay. `public_result.py` reads only fixed JSON fields, so snapshots are never
published; they travel only inside the private trace.

## Private traces

After Harbor exits and the runtime containers are removed, each trial job packs a raw trace
with `traces.py` and uploads it to a private team bucket, never to a GitHub artifact:

- `trace.tar.gz`: `harbor.log`, `job.json`, `identity.json`, the Harbor jobs directory (agent
  logs, Claude stream, trajectory, verifier logs and phase snapshots) and `public/`. The copied
  task and registry are left out. `redaction.json` inside records per-variable redaction counts.
- `result.json`: the same allowlisted result as the public artifact.

Keys are `harbor/v1/pr=<pr>/run=<run_id>/attempt=<run_attempt>/arm=<arm>/trial=<trial>/`.
Packing runs while the Bedrock credentials are still in the job environment and replaces the
exact values of `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` with
`[REDACTED:<name>]` in every file and path. Replacement is byte-level, so binary files are
scanned without decoding and files without a match are packed byte-identical; gzip tarballs
such as snapshots are unpacked and redacted per member. Symlinks and special files are skipped.
Values are never printed. Other secrets the agent may have produced, or encodings of these
values, are not detected.

Only then does a fresh `configure-aws-credentials` assume the writer role (1 hour) and upload
with `aws s3 cp`. The role may write anywhere under `harbor/v1/`, and the bucket is unversioned,
so an overwrite would destroy an earlier trace: each trial's session therefore carries an inline
policy limiting it to its own `run`/`attempt`/`arm`/`trial` prefix. The bucket name is masked in
logs. Missing configuration skips upload with a notice; pack or upload failures never change the
trial's result. Only CI uploads traces; local runs never do.

## Local calibration

`calibrate.py` measures run-to-run variance with an A/A design to choose N: it packs one
revision once in a throwaway worktree (or reuses `--registry`), prepares
`runs/<arm>-<trial>` for both arms from the same packages, builds the image once and runs
`run.py` for all trials with bounded concurrency, interleaving arms. Before each trial it runs
`aws configure export-credentials --profile <PROFILE>`, so a profile backed by IAM Identity Center
(SSO) or a `credential_process` hands every trial fresh credentials, and gives Harbor only those.
**The coding agent can do whatever that profile can do**: prefer a role limited to invoking the
pinned model on Bedrock over an administrator role. The caller ARN is printed and recorded in
`plan.json`. Each container takes 2 CPUs and 6 GiB, so pick a concurrency the host can hold.

```sh
PATH="$PWD/.harbor-bench/venv/bin:$PATH" python3 scripts/harbor-bench/calibrate.py \
  --trials 5 --concurrency 4 --output .harbor-bench/calibration --profile <PROFILE>
```

`--profile` defaults to `$HARBOR_AWS_PROFILE`. The profile must yield temporary credentials (with a
session token); a profile without an expiry cannot flag trials that outlived their credentials.
Local runs need no S3 bucket or other AWS resources beyond Bedrock access.

`--dry-run` stops after preparing the work dirs and writing `plan.json`: no image build,
credentials or model calls. A paid run writes `summary.md` and `summary.json`: the aggregate
report, per-metric coefficients of variation (per arm and pooled), pooled pass rates, the A/A
differences (their intervals should include zero), and trials per arm for 80% power to detect
10, 20 and 30% median changes, estimated by resampling the pilot through the report's own
bootstrap-median rule, plus a two-proportion estimate for a 20-point pass-rate drop. Per trial it also
records wall time, the host's 1-minute load average (start, end, sampled mean and max), since
contention biases seconds and timeouts, and whether the trial outlived its exported
credentials. Such trials count as infrastructure errors and are excluded from pass rates and
power estimates (`results/` marks them; the raw result stays in the work dir). Raw work dirs,
redacted `traces/<arm>-<trial>.tar.gz` and `results/` stay under `--output` on the local
machine: `calibrate.py` never uploads.

## Repository setup

- Environment **`harbor-bench-approval`** with required reviewers `@aws-devtools-labs/blocks-team`
  and deployments restricted to `main`. It holds no secrets; its single `approval` job is the one
  review per run.
- Environment **`harbor-bench`** with deployments restricted to `main` and **no** required
  reviewers: each benchmark matrix job references it, and reviewers here would be asked per job.
  It holds the secrets below and is the OIDC subject the roles trust.
- Environment secret **`AWS_ROLE_ARN`**: a role trusted for this repository's
  `:environment:harbor-bench` OIDC subject (audience `sts.amazonaws.com`, max session 10800 s)
  that only allows `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the
  pinned inference profile and its foundation models.
- Optional environment secret **`AWS_TRACES_ROLE_ARN`** and variable **`HARBOR_TRACES_BUCKET`**:
  a role trusted for the same subject (max session 3600 s) that may only `s3:PutObject` under
  `harbor/v1/*` in a private bucket (Block Public Access, owner-enforced, encrypted, TLS-only,
  expiring objects). Unset means traces stay on the runner and are discarded.

```sh
gh workflow run harbor-agent-check.yml --repo aws-devtools-labs/aws-blocks --ref main -f pr_number=123 -f trials=5
```

PR code is built without credentials, but its install scripts run in the approved model job:
review the candidate before approving. A new dispatch for the same PR cancels the running one.

## Security boundaries

The container gets only the model role's STS credentials, via exec environment. `run.py` strips
GitHub and OIDC variables before starting Harbor; only the report job can write to the PR.
Artifacts contain phase metrics, package hashes, tool-name-only traces and fixed verifier check
IDs, never prompts, commands, output, app files or exception text. Raw traces go only to the
private bucket, with the model credentials redacted, and the trace role is assumed only after
the agent's containers are gone. This is not a hostile-code sandbox: the agent can read its
model credentials and use the network until the session expires.

## Local verification

```sh
python3 -m unittest discover -s scripts/harbor-bench -p 'test_*.py'
node --check scripts/harbor-bench/registry.mjs scripts/harbor-bench/task/tests/ui.mjs
```

Prepare and build a task image from a fresh worktree (Node 22, Python 3.12, Docker Compose):

```sh
npm ci && npm run build && npm run publish:local
python3.12 -m venv .harbor-bench/venv
.harbor-bench/venv/bin/pip install -r scripts/harbor-bench/requirements.txt
python3 scripts/harbor-bench/prepare.py --registry dist-registry \
  --output .harbor-bench/candidate --arm candidate --commit "$(git rev-parse HEAD)"
image=$(python3 -c 'import json; print(json.load(open(".harbor-bench/candidate/identity.json"))["image"])')
docker build --tag "$image" .harbor-bench/candidate/task/environment
```

After changing `ui.mjs` or `verify.py`, check the browser verifier against the reference app and
two seeded defects, and that the root verifier still writes a snapshot without `node_modules`
when its checks fail (no model): `python3 scripts/harbor-bench/check_verifier.py --image "$image"`.

A paid single run takes credentials with Bedrock access to the pinned model in
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`; the agent receives them.
From a profile with temporary credentials:

```sh
eval "$(aws configure export-credentials --profile <PROFILE> --format env)"
PATH="$PWD/.harbor-bench/venv/bin:$PATH" python3 scripts/harbor-bench/run.py .harbor-bench/candidate
```

Raw logs under `.harbor-bench/` can contain credentials; they are git-ignored and stay local.
