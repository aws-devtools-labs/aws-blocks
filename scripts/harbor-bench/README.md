# Harbor agent check

An opt-in, **non-required** GitHub Actions check for AWS Blocks PRs. It packs the PR head and
its merge-base, then asks Claude Code to create a todo app, add due dates and add labels in one
resumed session per arm. One run per arm (**n=1**): the report is descriptive, not a statistical
claim. Nothing is deployed.

## What runs

`.github/workflows/harbor-agent-check.yml`, dispatched from `main` for an open PR:

1. Resolve the PR head and its merge-base with the PR base SHA.
2. On credential-free runners, `npm ci`, `npm run build` and `npm run publish:local` at both commits.
3. In the `harbor-bench` environment (blocks-team approval), `prepare.py` builds one task per arm
   with harness code from the workflow SHA and that arm's packed registry. `run.py` runs Harbor
   with a dedicated Bedrock-only role.
4. Harbor sends the three `task/steps/*/instruction.md` prompts to one Claude Code session.
   Subagent and web tools are disabled.
5. After each phase the root-owned verifier (`task/tests/verify.py`) kills agent servers,
   checks package provenance, runs `npm run build`, starts `npm run dev` as `node` and drives
   Chromium (`ui.mjs`) through every behavior added so far. It then checks that the records it
   created appear under the app's Blocks mock data directory (`.bb-data`), a heuristic that catches
   storage outside Blocks but not a backend writing its own files there. Finally it restarts the
   server and checks the records again in a fresh browser context.
6. A separate job renders `report.py` into the run summary and one advisory PR comment.

A phase passes only when the agent finished, same-session accounting is complete and every
verifier check passed. Failed create or due-date phases stop later phases.

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
change, missing counter or decrease stays unavailable, never zero. Cost is the CLI's list-price
estimate, not AWS billing. Rows with a failed or incomplete phase are marked not comparable.

Bounds: 200 turns and 25 minutes per phase, 5 minutes per verifier, 100 minutes per Harbor
process, 110 minutes per job. No retries and no dollar cap.

## Repository setup

- Environment **`harbor-bench`** with required reviewers `@aws-devtools-labs/blocks-team` and
  deployments restricted to `main`.
- Environment secret **`AWS_ROLE_ARN`**: a role trusted for this repository's
  `:environment:harbor-bench` OIDC subject (audience `sts.amazonaws.com`, max session 10800 s)
  that only allows `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the
  pinned inference profile and its foundation models.

```sh
gh workflow run harbor-agent-check.yml --repo aws-devtools-labs/aws-blocks --ref main -f pr_number=123
```

PR code is built without credentials, but its install scripts run in the approved model job:
review the candidate before approving. A new dispatch for the same PR cancels the running one.

## Security boundaries

The container gets only the model role's STS credentials, via exec environment. `run.py` strips
GitHub and OIDC variables before starting Harbor; only the report job can write to the PR.
Artifacts contain phase metrics, package hashes, tool-name-only traces and fixed verifier check
IDs, never prompts, commands, output, app files or exception text. This is not a hostile-code
sandbox: the agent can read its model credentials and use the network until the session expires.

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

After changing `ui.mjs`, check it against the reference app and two seeded defects (no model):
`python3 scripts/harbor-bench/check_verifier.py --image "$image"`.

A paid local run needs temporary credentials for the Bedrock-only role in `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`:

```sh
PATH="$PWD/.harbor-bench/venv/bin:$PATH" python3 scripts/harbor-bench/run.py .harbor-bench/candidate
```

Raw logs under `.harbor-bench/` can contain credentials; they are git-ignored and stay local.
