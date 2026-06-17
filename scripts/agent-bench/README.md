# Agent Bench

A non-blocking pull-request check that asks an LLM agent to implement a small
feature against each shipped template, then grades the result with a second
agent. Surfaces token counts, build/test outcomes, and a rubric score per
(template, task) on every pull request.

## Architecture

```
GitHub Actions matrix              AgentCore Harness microVM (per cell)
┌──────────────────────┐           ┌────────────────────────────────────┐
│ runner               │           │ Amazon Linux 2023, Node 22         │
│ ─ build local       │  S3       │ ─ scaffold via create-blocks-app  │
│   registry           │  ────────▶│ ─ npm install                     │
│ ─ orchestrator (TS) │  put/get │ ─ builder agent (shell + files)   │
│   in run-bench.ts    │           │ ─ npm run build                   │
│ ─ pull result back  │  ◀──────  │ ─ Playwright (chromium)           │
│ ─ emit envelope     │  S3       │ ─ judge agent (read-only files)   │
└──────────────────────┘           └────────────────────────────────────┘
```

* **Bedrock AgentCore Harness** runs each agent turn in its own Firecracker
  microVM with built-in shell + file tools.
* **GitHub Actions matrix** owns the per-cell parallelism (one runner per
  template).
* **S3** carries bytes between the runner and the microVM (the dist-registry
  tarball, the Playwright spec, the agent's written workspace).

## Files

| File | Purpose |
|------|---------|
| `agentcore.ts` | Thin SDK wrappers: `exec`, `invokeAgent`, `putToTransport`, `sessionId`, `stopSession` |
| `preflight.ts` | Idempotent pre-run probes (env, harness, exec, S3) |
| `run-bench.ts` | Per-cell orchestrator |
| `summarize.mjs` | Renders `result-*.json` files into a markdown table for the GitHub step summary |
| `package.json` | Workspace metadata + bench-only dev dependencies (`@aws-blocks/agent-bench`, `private: true`) |
| `tsconfig.json` | TypeScript config for this directory |

This directory is registered as an npm workspace (`scripts/agent-bench`) with
`private: true`, so its dependencies are scoped to the bench and never
published.

## Required configuration

The workflow expects three values to be set in the `publish` GitHub
environment for this repository:

| Name | Type | Description |
|------|------|-------------|
| `AWS_ROLE_ARN` | secret | OIDC role with `bedrock-agentcore:Invoke*` on the harness ARN, plus `s3:PutObject` on the registry bucket's `bench-uploads/*` and `bench/*` prefixes |
| `S3_BUCKET` | variable | Registry bucket name (existing) |
| `BENCH_HARNESS_ARN` | variable | ARN of a pre-created AgentCore Harness named `blocks_bench` |

Provisioning the harness, the harness execution role, and the IAM updates on
the OIDC role is out-of-scope for this repository. The workflow runs only
when these values resolve; preflight surfaces missing or misconfigured values
with a clear error before the bench starts.

## Adding a task

A task is a directory under `tasks/` containing:

```
tasks/<task-id>/
  config.yaml      id, name, tier, test_file, time_limit_sec, token_budget
  PROMPT.md        natural-language description the builder agent reads
  test.spec.ts     Playwright spec graded against the running app
```

Add the new `(template, task)` pairing to the matrix in
`.github/workflows/pr-agent-bench.yml`.

## Local development

`run-bench.ts` runs locally given the same three configuration values. The
workspace exposes scripts you can run from the repo root or from this directory:

```bash
# from the repo root
npm run preflight  --workspace=@aws-blocks/agent-bench
npm run bench      --workspace=@aws-blocks/agent-bench -- \
  --template default --task realtime-todos --output result.json
npm run typecheck  --workspace=@aws-blocks/agent-bench
```

See the source for the exact environment variables expected.
