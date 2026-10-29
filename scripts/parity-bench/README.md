# Parity bench — local vs deployed, per Building Block

The e2e suites check that each Building Block does what we intended. The parity
bench asks a different question: **does a block behave the same on the local
dev server (mocks) as on a deployed stack (AWS)?** It never asserts an expected
value. It records what happened in both environments, and the deployed run is
the reference for the local run.

`@aws-blocks/parity-bench` is a private workspace package, consumed as TypeScript
source by the test apps. It isn't built or published. The Lambda bundler and
`tsx` compile it in place.

## What it records

| Source | What it records | Turned on by |
|---|---|---|
| **Recorder** | Every call a stack's existing e2e suites make through the generated client: test name, call ordinal, method, args, outcome, duration | `E2E_PARITY_DIR=<dir>` |
| **Fixed probe cases** | One run of a catalog case that drives a block into territory the e2e suites never reach | `E2E_PARITY_PROBES=true` |
| **Slider cases** | A breakpoint search over one dimension (rows, bytes, items, seconds). The bench finds the first failing value in each environment and compares it with the documented limit | `E2E_PARITY_PROBES=true` |

A slider runs a binary search (about log2 of the range in attempts, plus 3
re-checks above the breakpoint) instead of stepping through every value. If a
value above the breakpoint succeeds again, the result is reported as
non-monotonic instead of being trusted.

## Run it (comprehensive app)

```bash
cd test-apps/comprehensive
npm run parity:local      # e2e + probes against the local dev server → .parity/local/
npm run parity:sandbox    # e2e + probes against a fresh sandbox stack → .parity/sandbox/ (deploys, then destroys)
npm run parity:report     # diff → .parity/report/report.md + findings.json
```

`parity:sandbox` needs AWS credentials for a **test** account, like `test:e2e:sandbox`.

To filter out noise (eventual consistency, timing), record the deployed side twice and pass the
second run as a baseline. Anything whose two deployed runs disagree is reported as `noisy` and
excluded from the diff:

```bash
BLOCKS_SANDBOX_KEEP=1 npm run parity:sandbox
E2E_PARITY_DIR=.parity/sandbox-2 E2E_PARITY_PROBES=true npm run test:sandbox
npx tsx ../../scripts/parity-bench/src/cli/report.ts --local .parity/local --deployed .parity/sandbox --baseline .parity/sandbox-2
```

`E2E_PARITY_SES_SANDBOX=true` additionally enables the two email cases that send to an unverified
recipient. Set it only for an account whose SES is in sandbox mode, where SES rejects those sends.
With production access the mail would really go out and hard-bounce.

## Reading the report

The report starts with one row per block. Next comes a **Breakpoints** table for the sliders
(documented limit · local · deployed), then the non-matching calls and cases per block:

| Verdict | Meaning |
|---|---|
| **SILENT** | Works locally, fails deployed. For a slider, the local breakpoint is higher than the deployed one, or doesn't exist. The worst kind: the developer finds out in production |
| error shape differs | Both fail (or break at the same point) with a different error `name` or HTTP status, which is what `isBlocksError` matches on |
| value differs | Both succeed with different results, after normalizing ids, timestamps, URLs and echoed inputs |
| fails locally only | Annoying, but safe |
| noisy | The two deployed runs disagree; excluded |
| unmatched | Ran in one environment only, usually because a test failed or was skipped there |

**Fidelity** = same ÷ compared. Unmatched and noisy entries don't count.

## Layout

```
src/core/      pure, no I/O: types (the contract), catalog validation, breakpoint search, differ + report
src/kinds/     reusable probe shapes and exact-size payload generators: countLimit, sizeLimit, utf8OfBytes, idBatches
src/server/    the default-deny `probe` namespace (createProbeMethods), runCase/observe helpers, CDK wiring (./cdk)
src/client/    the e2e client recorder and the node:test driver for fixed and slider cases
src/packs/     one pack per block area: <pack>.cases.ts (pure data) + <pack>.probe.ts (runner); catalog.ts
src/cli/       parity-report, parity-validate-catalog
test/          unit tests for the pure core
```

## Mounting the bench in a stack

```ts
// aws-blocks/index.ts — reuse the instances the stack has; packs build the rest from `scope`
import { createProbeRunners, PARITY_CASES } from '@aws-blocks/parity-bench/packs';
import { createProbeMethods } from '@aws-blocks/parity-bench/server';
const probeRunners = createProbeRunners(scope, { dsql, realtime }); // leave a dep out → its pack is skipped
export const probe = new ApiNamespace(scope, 'probe', () => createProbeMethods(PARITY_CASES, probeRunners));

// aws-blocks/index.cdk.ts
import { enableParityProbes } from '@aws-blocks/parity-bench/cdk';
enableParityProbes(blocksStack);

// e2e entry
import { installParityRecorder, parityProbeTests, recordClient } from '@aws-blocks/parity-bench/client';
import { PARITY_CASES } from '@aws-blocks/parity-bench/catalog';
installParityRecorder('main');                 // module top level
api = recordClient(module.api, 'api');          // after importing the generated client
parityProbeTests(() => module.probe, PARITY_CASES);
```

`createProbeRunners` builds nothing unless `E2E_PARITY_PROBES=true`, so an ordinary deploy of the
stack gets none of the packs' resources.

## Adding cases

- **A new limit, entry point or condition for an existing pack:** add data to `<pack>.cases.ts`.
  Prefer a slider (`sweep: { param, min, max, unit, documented }`) over limit−1/limit/limit+1
  triples. Every case cites its `source`: an AWS doc URL, an RFC, or a README/DESIGN.md line.
- **A new pack:** `<pack>.cases.ts` + `<pack>.probe.ts`. Build the runner from a kind in
  `src/kinds/` where one fits, otherwise from `runCase({ setup, act, cleanup })`. `act` returns a
  small summary and never asserts. Register the pack in `catalog.ts` (`PARITY_CASES`, `PACK_IDS`)
  and `packs/index.ts`.
- `npm test` here runs the unit tests and `parity-validate-catalog`. Then run `parity:local` in a
  stack, then `parity:sandbox`.

Each attempt must finish well under 20 s deployed, because of the API Gateway 29 s limit.

## Security

`probe` is a network-reachable RPC namespace, so it is **default-deny**. Every method answers 404
unless the serving process has `E2E_PARITY_PROBES=true`. The e2e harness passes the flag to the
local dev server, which binds to loopback. `enableParityProbes` registers it on a deployed stack
only when the deploy itself ran with the flag set. Callers can only pick a case id from the fixed
catalog, plus, for a slider, one integer inside that case's declared range. They can't supply SQL,
sizes beyond the range, or targets.

Recordings redact values under credential-like keys (`token`, `password`, `cookie`, `session`, …)
and are written only under `.parity/`, which is git-ignored.
