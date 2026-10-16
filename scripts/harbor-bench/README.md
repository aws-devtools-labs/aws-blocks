# Harbor agent check

An opt-in, **non-required advisory** GitHub Actions check for AWS Blocks PRs.
It builds the PR head and its own merge-base, then asks Claude Code to create a todo
app, add due dates, and add labels. Each arm uses **one Harbor container and one
resumed Claude Code conversation**. There is no pre-created application, deployment,
LLM judge, dollar ceiling, or statistical claim: **n=1 per arm**.

The workflow is `.github/workflows/harbor-agent-check.yml`. It is manually requested
for an open PR and requires `blocks-team` environment approval before model access.
It does not provision application infrastructure or change merge requirements.

## What runs

1. From the trusted default-branch workflow, resolve the requested open PR head and
   its merge-base with the PR base SHA. Freeze both revisions for this run. It is not
   an old stored score or GitHub's synthetic merge. Baseline-result reuse is deferred.
2. On credential-free runners, independently `npm ci`, `npm run build`, and
   `npm run publish:local` at both commits. This reuses the repository's packer.
3. Prepare identical tasks using harness code from the trusted workflow SHA, with
   one immutable packed registry and a fresh npm cache per arm. The agent installs
   the selected scaffolder, executes it with the bare template, then builds the app.
4. Harbor's native multi-step runner calls Claude Code once, then `--continue`
   twice. The filesystem, app `.bb-data`, and Claude session survive. Subagent and
   web tools are disabled to keep the bounded single-agent comparison simple.
5. After every phase a root-owned verifier kills agent-owned servers, verifies
   installed package bytes, runs the real app build, starts the local app as the
   unprivileged `node` user, and drives Chromium. It checks all earlier CRUD,
   completion, due-date/label behavior and unpredictable records created in previous
   phases. It then kills/restarts the server and opens a **new browser context** to
   check persistence without browser storage. No `.bb-data` reset occurs.
6. A separate job renders the comparison, publishes an advisory PR comment, and
   attaches the report. Only this job has `pull-requests: write`; it has no AWS
   role and never executes files from result artifacts.

A phase passes only when the agent completed, accounting is available, model/session
pins are observed, package provenance passes, and the behavioral verifier passes.
The first phase additionally requires tool-input evidence of scaffolder invocation
and reading the skill, scaffolded AGENTS, and installed Blocks README. A timeout,
turn limit, missing result, failed test, or changed session is **not a success**.
The jobs may be red; advisory means “not required”, not “paint failures green”.
Failed create or due-date verification stops later phases. Harbor also stops on
unrecoverable setup/agent/verifier errors; missing phases stay `not_run`.

## Pins and instruction delivery

- [Harbor source](https://github.com/laude-institute/harbor/tree/09f5b964f8e5075f7e52fd08c9994dfc80ad5d24):
  immutable commit `09f5b964f8e5075f7e52fd08c9994dfc80ad5d24` (package version 0.24.0).
  The adapter subclasses its installed `ClaudeCode`; no private harness dependency.
- Claude Code `2.1.296`; auto-updater disabled.
- Bedrock `global.anthropic.claude-opus-5-5`, endpoint region `us-east-1`.
  All Claude tier/fast/subagent model aliases point at this same profile.
- Node `22.23.3`, Playwright `1.58.2`, Python `3.12`.
- Public [AWS Blocks skill](https://github.com/aws/agent-toolkit-for-aws/blob/2cb0fa1c2e668e1bb075028800b6b27efb95779e/skills/core-skills/aws-blocks/SKILL.md)
  from `aws/agent-toolkit-for-aws@2cb0fa1c2e668e1bb075028800b6b27efb95779e`, downloaded
  with SHA-256 verification. It is placed at
  `/home/node/.claude/skills/aws-blocks/SKILL.md`; the prompt explicitly requires
  reading it. Harbor also copies it into the session's skill directory.
- App `AGENTS.md` is delivered by **that arm's real scaffolder package**, not copied
  from this monorepo's contributor guide. The agent is explicitly instructed to
  read it and the installed version's package docs.

Harbor/CLI/task/skill are fixed across arms. This is not a fully hermetic dependency
snapshot: apt packages, image tags, Harbor's transitive Python dependencies, and
non-Blocks npm ranges can resolve differently over time. The repository lockfile
controls each monorepo build; app package locks record the agent's actual resolution.

## Package provenance

Each arm has its own loopback-only registry in its own container. The registry never
falls back to public npm for missing `@aws-blocks/*` packages. Public npm is still
available for third-party dependencies. `/etc/bench-npmrc` and the empty global config
are root-owned, and no host npm config/cache is mounted. Installed Blocks packages
must be non-symlink installations, with lockfile version, registry URL, and integrity
matching the chosen manifest. The root-owned request ledger must show the tarball
was served. Every packed regular file is compared with the installed bytes, including
`@aws-blocks/create-blocks-app` in `/app/bootstrap`. This catches public fallbacks,
workspace links, stale same-version cache hits, and edits to installed packages.
The app must use Blocks RPC and persistence; UI mutations are observed as backend
POST requests. Source checks are a sanity check, not a formal proof of semantic use.

A benchmark-only PR can produce **byte-identical baseline/candidate packages**. The
report calls that an **A/A infrastructure demonstration**. Differences can include
agent and runtime variation, not evidence of a framework efficiency win.

## Usage semantics

Claude 2.1.296's result `modelUsage` and `total_cost_usd` are cumulative across
`--continue`, while `usage`, `num_turns`, and the stream's tool events are invocation
local. `accounting.py` differences cumulative snapshots exactly once, retaining
uncached input, cache read, cache creation/write, and output separately. It also
updates Harbor's context to phase deltas so Harbor does not sum cumulative totals.
Turns are reported directly. Message/tool IDs are deduplicated within each stream.
Session changes, missing counters/results, or decreasing counters remain unavailable,
not zero or a fabricated total. Cost is the CLI's **list-price estimate**, not AWS billing.

The report shows signed absolute and percentage differences for each phase and for
whole-run totals, including turns, tool calls and agent time. Available measurements
remain visible even when correctness fails. Such rows are marked not comparable for
efficiency; less work on a failing app is not an efficiency win. A later failed phase
does not hide earlier passing pairs. Missing counters stay unavailable, and a zero
baseline has no percentage difference. One run per arm remains descriptive only.

The visible report leads with a fixed assertion description when verification fails,
then per-phase deltas and guidance-inspection counters. Verbose measurements and
whole-run totals are expandable. Public diagnostics contain only known check/stage
identifiers, error kinds, fixed reason codes (such as replaced controls or unchanged
checkbox state) and browser/HTTP error counts. DOM text, console messages, response
bodies and exception text remain private to the runner log.

Before model credentials are assumed, a credential-free browser self-check exercises
the verifier on a small reference app. It accepts backend-confirmed checkbox updates
and rejects lost completion and duplicate-label defects at their named assertions.
The reference is never copied into agent task images. Checkbox verification clicks
once, waits for the backend response, then verifies saved state after reload; it does
not require an optimistic immediate UI update from Playwright's `check()` helper.

Guidance counters count deduplicated tool requests for skills, app AGENTS, packaged
block docs and framework implementation source. Direct Read/Grep/Glob requests and
simple shell read/search commands are recognized. Embedded scripts, multiline shell,
and automatic instruction loading are not counted. A request is not proof that a
file was read or understood. Failed tools count explicit error results only.

Bounds: **200 turns and 25 minutes per phase**, 5 minutes per phase verifier,
100 minutes for the Harbor process, and a 110-minute workflow job including setup.
No automatic trial retries and **no dollar cap**. The role session is 3 hours to
cover this bounded job without refreshing credentials.

## Repository configuration and optional launch

Repository administrators must configure:

- GitHub environment **`harbor-bench`**, with required reviewers
  **`@aws-devtools-labs/blocks-team`** and deployment refs restricted to `main`.
  Review the exact candidate SHA shown in the run summary before approval.
- Environment secret **`AWS_ROLE_ARN`** pointing to a dedicated model-only role.
  Trust audience `sts.amazonaws.com` and the exact repository OIDC subject prefix
  plus `:environment:harbor-bench`; inspect the OIDC customization API because
  repositories can use immutable IDs. The maximum session duration is 10800 seconds.
- Model permissions: only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`
  on the selected global inference profile and its Opus 5.5 foundation-model ARNs.
  No deployment, registry write, secret read or role-chaining permission is needed.
- Report-job permission to comment on the requested PR. No write token enters the
  model container. GitHub artifacts suffice; a baseline store is not required.

After the workflow is reviewed and merged to `main`, a repository maintainer can run:

```sh
gh workflow run harbor-agent-check.yml --repo aws-devtools-labs/aws-blocks \
  --ref main -f pr_number=123
```

Only `workflow_dispatch` from upstream `main` executes. Opening or updating a PR does
not automatically spend model tokens. Any open PR targeting `main` can be requested,
including docs-only changes; there is no path filter. Fork PR package code can be
built on credential-free runners, but its installation still requires review before
the protected model job is approved. Do not approve untrusted package code merely
because the controller is trusted. No `pull_request_target` is used.

The controller, verifier and report come from the workflow SHA, not the candidate.
Harness changes must be reviewed and merged before this lane measures them; candidate
package changes are the variable under test. A new dispatch replaces a stale run for
the same PR. These results stay advisory, with no blocking threshold until the team
has a reliable baseline and agrees on thresholds. Missing approval does not block
merging. Keep this workflow out of required branch checks.

## Local verification and paid smoke

From the repository root, credential-free harness tests:

```sh
python3 -m unittest discover -s scripts/harbor-bench -p 'test_*.py'
node --test scripts/harbor-bench/test-browser-diagnostic.mjs
node --check scripts/harbor-bench/registry.mjs
node --check scripts/harbor-bench/task/tests/ui.mjs
```

After building a task image, run the same deterministic browser self-check locally:
`python3 scripts/harbor-bench/check_verifier.py --image <built-task-image>`.

Repository checks remain the contributor guide's build, `lint:deps`, unit tests, and
local e2e. There are no published-package changes, so this prototype needs no package
changeset. Run workflow syntax validation with actionlint if available.

To prepare a real candidate locally (fresh disposable worktree, Node 22, Python 3.12,
Docker with Compose; **do not reuse an existing `dist-registry`**):

```sh
npm ci
npm run build
npm run publish:local
python3.12 -m venv .harbor-bench/venv
.harbor-bench/venv/bin/pip install -r scripts/harbor-bench/requirements.txt
python3 scripts/harbor-bench/prepare.py --registry dist-registry \
  --output .harbor-bench/candidate --arm candidate --commit "$(git rev-parse HEAD)"
image=$(python3 -c 'import json; print(json.load(open(".harbor-bench/candidate/identity.json"))["image"])')
docker build --tag "$image" .harbor-bench/candidate/task/environment
```

Then export **only temporary credentials for the dedicated Bedrock-only role** as
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (never use an admin
session). The following is a real paid three-phase run, not a scaffolding-only smoke:

```sh
PATH="$PWD/.harbor-bench/venv/bin:$PATH" python3 scripts/harbor-bench/run.py .harbor-bench/candidate
```

For a local baseline, build/pack the merge-base of the candidate and requested base
revision in another fresh worktree, then prepare both arms with the **same reviewed
harness revision**. Record all three SHAs; do not reuse a previously generated app.
On cancellation outside GitHub, remove that run's Docker Compose containers explicitly;
normal Harbor completion deletes them. Raw files under `.harbor-bench` are local only.

## Artifacts and security boundaries

Public `harbor-result-{arm}` artifacts contain phase result JSON, selected package
names/versions/hashes, tool-name-only chronological traces, fixed verifier check
identifiers and guidance-request counts. The comparison artifact and PR comment link
to the workflow run. **Raw prompts, commands/output, native sessions, ATIF text, app
files, DOM/console text and exception tracebacks are not uploaded.** Tool names and
diagnostic fields are allowlisted; session IDs and AWS identities are excluded.

The container receives **only model-role STS credentials**, passed via exec environment,
not build args, Docker image layers, files, artifacts, or configuration JSON. The host
retains GitHub token and OIDC request credentials; `run.py` strips them from Harbor's
process environment and the adapter uses an explicit AWS allowlist. Checkout never
persists GitHub credentials. The report job alone has GitHub write permission.

This is **not a hostile-code sandbox**: the agent can read/exfiltrate its model-role
credentials, use public network access, and invoke Bedrock until the STS session expires.
Container non-root execution, root-owned registry/verifier, `no-new-privileges`, no
Docker socket/repository/host config mount, model-only IAM and protected-environment
approval reduce exposure; they do not make arbitrary PR code safe. Candidate package
lifecycle scripts remain executable code and require review. The harness and report
are loaded from the trusted workflow SHA. Verifier/browser isolation protects against
accidental mistakes, not a formal defense against a malicious candidate.

## Implementation map

- `prepare.py`, `task/environment/Dockerfile`, `registry.mjs`: pinned runtime and per-arm packages.
- `agent.py`, `accounting.py`: real Harbor Claude adapter and cumulative-session accounting.
- `task/steps/*/instruction.md`: incremental user requests and explicit UI contract.
- `task/tests/*`, `provenance.py`: real build/browser/persistence/package verification.
- `run.py`, `public_result.py`, `report.py`: bounded execution and allowlisted reporting.
- `test_harness.py`: credential-free accounting, provenance, reporting, and redaction regression tests.
