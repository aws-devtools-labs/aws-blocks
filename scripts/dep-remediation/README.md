# @aws-blocks/dep-remediation

Agentic remediation for the **weekly minor-only dependency bump**
([`.github/workflows/dependency-update.yml`](../../.github/workflows/dependency-update.yml)).

## Why

The weekly job upgrades dependencies to their latest **minor/patch** versions only
(`npm-check-updates --target minor` — never a new major). Semver says a minor bump is non-breaking,
but publishers don't always honor that: a "minor" can still break our build, tighten a type, change a
runtime behavior, or introduce a transitive/peer **dependency conflict**. When that happens the job's
build/e2e used to go red and a human had to patch it by hand.

This package is the automated fix. When (and only when) the raw minor bump breaks `npm run build` or
`npm run test:e2e:local`, the workflow invokes a **Strands + Bedrock** agent that reads the failure,
finds the root cause in the upgraded dependency, and patches **our source** (never the version bumps)
until build + e2e pass again. The workflow then re-runs build + e2e as the authoritative gate before
opening the PR, and the PR body flags that remediation ran.

## How it works

- **`remediate.ts`** — entrypoint. Builds a failure summary from the CI step outcomes, constructs a
  minimal Strands `Agent` (Bedrock model + the vended `bash` + `fileEditor` tools, routed through a
  workspace-rooted sandbox), and runs one `invoke()` with a turn cap, wrapped in an app-level
  throttle-retry loop.
- **`prompts.ts`** — the system prompt. Orients the agent to `AGENTS.md`, the minor-bump context, and
  the hard rules (don't revert the bumps; no `as any`/`@ts-ignore`; smallest change; stop and flag a
  genuine public-API breaking change for a human).
- **`steps/run-shell.ts`** — a workspace-rooted `WorkspaceSandbox` (a trimmed sibling of the
  agent-bench sandbox, without the untrusted-input UID isolation — see the file header for why that's
  safe here) with a timeout floor so `npm install`/`npm run build` aren't killed.
- **`steps/bedrock-retry.{mjs,ts}`** — the Bedrock invoke-layer retry classifier + backoff
  (self-contained; mirrors the agent-bench copy so the two workflows don't couple).
- **`steps/summarize.mjs`** — pure CI-outcome→summary mapping.

## Security

The agent runs a shell over our checkout, so least-privilege matters:

- The job is only triggered by our own **schedule / manual dispatch** — never by fork or PR input —
  so there is no untrusted prompt-injection vector.
- The OIDC session in the workflow is narrowed by an **inline session policy to Bedrock
  model-invocation only** (same mechanism documented at length in `agent-bench.yml`), so even the
  shell-capable step cannot reach any other AWS API.
- The agent is instructed not to touch `.github/`, git config, or credentials.

## Local checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # tsc --noEmit + node --test steps/*.test.mjs
```

Running the agent itself requires AWS credentials with Bedrock access and the `WORKSPACE` env var; it
is designed to run inside the workflow, not locally.
