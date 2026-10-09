# Bench tasks

Each subdirectory is one benchmark task with exactly two files:

- **`PROMPT.md`** — the instructions handed to the building agent.
- **`test.spec.ts`** — the Playwright grader run against the agent-built app.

The reference app is **not** committed; the agent builds it during the bench,
then the spec grades the running dev server.

## Intentional per-spec helper duplication

Every spec re-declares the same small helpers inline — `watchErrors(page)`, a
JSON-RPC `rpc(ctx, method, params)` wrapper, and the `uniq(base)` seed — rather
than importing them from a shared module. **This duplication is deliberate:**
each `test.spec.ts` must be a self-contained grader that can be dropped next to
a single task app and run on its own, with no cross-task imports or build step.
Keeping the helpers local keeps the specs portable and independently readable;
do not refactor them into a shared import.

## Harness contract

The bench runs each spec **serially with `workers: 1`** (see
`scripts/agent-bench/steps/3-build-and-test.sh`). Specs assert against a
**shared server-side store** (e.g. the presence roster, the file list) and scope
their assertions to their own `uniq(...)` names rather than to absolute counts.
Those assertions are race-free **only** under `workers: 1`; running with more
workers would require reworking them to tolerate concurrent runners. Each spec
that relies on this carries a `// HARNESS CONTRACT: requires workers:1` banner.

Two independent counters back the helpers so neither perturbs the other:

- **`rpcSeq`** — the JSON-RPC `id` on each request.
- **`uniqSeq`** — the monotonic component of `uniq(...)` test-data seeds.

## Test-only backdoors (`BLOCKS_MOCK`)

A few tasks need a server-side hook the grader can read because it has no real
side channel (e.g. `cognito-profile`'s `api.getLastCode`, which surfaces the
most-recently delivered OTP since the grader has no mailbox). Such hooks MUST be
gated: annotated `@blocksSkipCodegen` and returning `null` unless
`process.env.BLOCKS_MOCK === 'true'`, so they are inert in a real deployment.
The harness exports `BLOCKS_MOCK=true` for the graded dev server.
