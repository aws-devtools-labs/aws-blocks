# test-infra: Persistent Test VPCs

This directory contains infrastructure that is deployed **once** and **not torn down** between test runs.

## Why?

- VPC creation takes 2-3 minutes
- VPC deletion can fail (Lambda ENIs linger 10-20 min)
- Each VPC counts against the region's VPC quota (20 in the E2E accounts)

## Stacks

The app is `vpc-test-app.ts`; `vpc-test-stack.ts` builds the stacks and
`vpc-test-stack.test.ts` checks them (`npm test`).

| Stack | Consumed by | CI lane |
|-------|-------------|---------|
| `BlocksTestVpc` | `test-apps/vpc-smoke/`, and `test-apps/compute-smoke/` in `e2e-compute-endpoints.yml` | E2E VPC Smoke (`blocks-test-vpc-<n>`) and E2E Compute Endpoints (`blocks-test-vpc-endpoints-<n>`) |
| `BlocksComputeTestVpc` | `test-apps/compute-smoke/` | E2E Compute Smoke (no lock) |
| `BlocksComputeTestVpcEndpoints` | permanent endpoints in `BlocksComputeTestVpc` | E2E Compute Smoke |

AWS permits only one private-DNS interface endpoint per service per VPC, so two
stacks that each create their own endpoints can't share a VPC at the same time.

- `BlocksTestVpc` has **no** endpoints. The apps that use it deploy with
  `provisionEndpoints: true`, so `finalizeVpc` creates the endpoints in the
  app's own stack, exercising the real auto-detection path end-to-end. Only one
  such app may run per account at a time. Today that is E2E Compute Endpoints
  alone (its group `blocks-test-vpc-endpoints-<n>`): E2E VPC Smoke deploys
  nothing into the VPC while its tests are off, so it keeps its own group
  rather than wait behind an hour-long run. When VPC Smoke's tests create
  endpoints again, put both jobs in one group. Both jobs deploy `BlocksTestVpc`
  first (a no-op when unchanged); a PR that changes that stack can see one of
  them fail with "UPDATE_IN_PROGRESS" and need a re-run.
- `BlocksComputeTestVpc` has **permanent** S3 and DynamoDB gateway endpoints and
  SQS and CloudWatch Logs interface endpoints (private DNS on), in the
  `BlocksComputeTestVpcEndpoints` stack. compute-smoke deploys with
  `provisionEndpoints: false`, so any number of Compute Smoke runs share the VPC
  at once.

The permanent endpoints are configured like the framework's: gateway endpoints
on every subnet's route table, interface endpoints in the private subnets. One
difference: the framework's endpoint security group admits 443 only from the
app's Blocks compute security group; the permanent one admits 443 from the VPC
CIDR, since it can't name a group each test stack creates and deletes. The
framework's own endpoints and that narrower rule are checked by compute-smoke's
template test (Unit Tests, every PR) and deployed for real by
`.github/workflows/e2e-compute-endpoints.yml` (nightly, and on PRs that change
VPC or compute code). If compute-smoke gains a Building Block that needs another
endpoint, its template test fails until `COMPUTE_TEST_VPC_ENDPOINTS` in
`vpc-test-stack.ts` lists it.

The endpoints are in their own stack because CI deploys `BlocksComputeTestVpc`
from each PR's checkout. `BlocksComputeTestVpc` exports the subnet and route
table IDs the endpoints stack imports, so a branch from before the endpoints
can't delete them: CloudFormation refuses to remove an export in use, and the
branch's Compute Smoke fails at "Ensure persistent compute test VPC" until it is
rebased onto main.

### Changing the endpoints

Compute Smoke runs share these stacks without a lock, and each run deploys them
from its own checkout. A PR that changes them therefore changes them for every
run in its E2E account while it is open, and runs from other branches put them
back. Keep such changes additive (add an endpoint first; remove an old one only
after every open PR has the addition), and expect "stack is in
UPDATE_IN_PROGRESS" failures if two such runs overlap. A PR that changes only
`test-infra/` selects no PR Checks E2E job, so put an `E2E: compute-smoke`
trailer on its head commit to deploy the change once, in its own account, before
it merges; after the merge, runs from main deploy it to all three accounts. The same export lock
that stops old branches also stops the endpoints stack from dropping one of the
VPC stack's exports in a single deploy: first keep the export with
`Stack.exportValue` in `BlocksComputeTestVpc`, deploy, then remove it.

### Leaked app stacks

cleanup-stacks.yml does not sweep `bb-compute-smoke-*` stacks. One left behind
by a run that could not tear down (for example `bb-compute-smoke-<id>-ep-<n>-<attempt>`
from E2E Compute Endpoints in `BlocksTestVpc`, or one from a branch older than
the permanent endpoints in `BlocksComputeTestVpc`) keeps its endpoints. In
`BlocksTestVpc` every later run that creates endpoints fails; in
`BlocksComputeTestVpc` the endpoints stack fails to deploy. The errors read
"already has a route with destination-prefix-list-id" or "private-dns-enabled
cannot be set".
Delete the stack and its `-vpc-ref` sibling in that account.

### Rolling back

Revert the change on main, then per account delete `BlocksComputeTestVpcEndpoints`
and deploy `BlocksComputeTestVpc` from main (which drops the exports). Do this
while no Compute Smoke run is in flight in that account.

## Usage

### Deploy

CI runs these on every run of the lane that needs them (a no-op when nothing
changed). To deploy by hand, with credentials for the E2E account, in
`us-east-1`:

```bash
cd test-infra
npm install
npx cdk deploy BlocksTestVpc
npx cdk deploy BlocksComputeTestVpc BlocksComputeTestVpcEndpoints
# or all three at once:
npx cdk deploy --all
```

Deploy `BlocksComputeTestVpcEndpoints` only when no stack in the account has its
own endpoints in `BlocksComputeTestVpc` (for example a compute-smoke stack from
a branch older than the permanent endpoints); otherwise its endpoints fail to
create with "already has a route with destination-prefix-list-id" or
"private-dns-enabled cannot be set".

Each VPC stack outputs its VPC ID. Set the `VPC_TEST_VPC_ID` environment variable
for the downstream test stack you're running:

```bash
# For the VPC smoke app:
export VPC_TEST_VPC_ID=$(aws cloudformation describe-stacks \
  --stack-name BlocksTestVpc \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
  --output text)

# For the compute smoke app:
export VPC_TEST_VPC_ID=$(aws cloudformation describe-stacks \
  --stack-name BlocksComputeTestVpc \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
  --output text)
```

### Reference from test apps

Each test app reads the VPC ID from the `VPC_TEST_VPC_ID` env var or `-c vpcId=vpc-xxx` CDK context:

```bash
cd test-apps/vpc-smoke
VPC_TEST_VPC_ID=vpc-abc123 NODE_OPTIONS="--conditions=cdk" npx cdk deploy
```

compute-smoke adds no endpoints unless `COMPUTE_SMOKE_PROVISION_ENDPOINTS=true`
(set by `e2e-compute-endpoints.yml`, which points it at `BlocksTestVpc`).

## Resources Created

| Resource | Stack | Purpose | Cost |
|----------|-------|---------|------|
| VPC (2 AZs) | each VPC stack | Network isolation for the smoke-test apps | none |
| 1 NAT gateway | each VPC stack | Egress for private-with-egress subnets | ~$32/mo |
| Public / private-with-egress / isolated subnets | each VPC stack | Cover every placement the app may select | none |
| `VpcId` CfnOutput | each VPC stack | Consumed by the app stack via `VPC_TEST_VPC_ID` | none |
| S3 + DynamoDB gateway endpoints | `BlocksComputeTestVpcEndpoints` | Routes on all six route tables | none |
| SQS + CloudWatch Logs interface endpoints, one security group | `BlocksComputeTestVpcEndpoints` | One ENI per private subnet each, private DNS on | ~$29/mo |

> **VPC quota note:** the two VPC stacks use 2 of the region's VPCs (quota 20
> in the E2E accounts). Account for that before adding more persistent VPCs.

## Do NOT Delete

All three stacks are tagged with `blocks:do-not-delete=true`. Deleting a VPC
stack breaks the corresponding smoke tests in CI until redeployed. Deleting
`BlocksComputeTestVpcEndpoints` doesn't fail Compute Smoke's deploy, but its
endpoint checks fail (SQS and Logs resolve to public addresses) until the next
run's "Ensure persistent compute test VPC" step recreates it.

# GitHub OIDC role for E2E (`github-oidc-stack.ts`)

PR E2E jobs, including Dependabot PRs, run third-party code with AWS
credentials. They therefore run in **dedicated E2E accounts** that hold only
test stacks.

This stack creates, in each of them:

| Resource | Purpose |
|----------|---------|
| GitHub OIDC identity provider | Lets GitHub Actions exchange its OIDC token for AWS credentials (skipped if `GITHUB_OIDC_PROVIDER_ARN` is set) |
| `blocks-github-e2e` role | Assumable only by jobs in this repo's `e2e` GitHub environment; CDK deploys, E2E stack/bucket cleanup, the `cleanup-stacks.yml` quota sweeps (REST APIs, API Gateway CloudWatch roles, CloudFront response headers policies), Cognito admin calls, Supabase test secret |
| `blocks-github-bench` role | Account 1 only (`E2E_AGENT_BENCH=1`). Agent bench (`agent-bench.yml`), assumable only by jobs in this repo's `agent-bench` GitHub environment; Bedrock model invocation and `bench/*` in the bench bucket |
| Agent bench bucket | Account 1 only (`E2E_AGENT_BENCH=1`). Per-cell bench results and the baseline the PR scoreboard compares against |

The stack is pinned to `us-east-1`, the region every E2E workflow and
`cleanup-stacks.yml` use. It is deployed **by hand, once per account**, not by
CI:

```bash
cd test-infra
npx cdk bootstrap aws://<e2e-account-id>/us-east-1   # once per account
E2E_ACCOUNT_ID=<e2e-account-id> npm run deploy:oidc
```

The app (`github-oidc-app.ts`) refuses to synthesize unless `E2E_ACCOUNT_ID` is
set and matches the account of the active credentials.

An IAM OIDC provider is a per-account singleton for its URL. If the account
already has one for `token.actions.githubusercontent.com`, pass its ARN so the
stack reuses it instead of failing with `EntityAlreadyExists`:

```bash
E2E_ACCOUNT_ID=<e2e-account-id> \
GITHUB_OIDC_PROVIDER_ARN=arn:aws:iam::<e2e-account-id>:oidc-provider/token.actions.githubusercontent.com \
  npm run deploy:oidc
```

Add the `RoleArn` output to the `AWS_ROLE_ARNS` secret (see below). Deploy this
stack only into dedicated E2E accounts.

### Agent bench (account 1)

The agent bench isn't spread over the pool. Account 1 also holds its role and
results bucket. Deploy account 1 with `E2E_AGENT_BENCH=1`, every time: a deploy
without it removes the bench role (the bucket is retained).

```bash
E2E_ACCOUNT_ID=<account-1-id> E2E_AGENT_BENCH=1 npm run deploy:oidc
```

Set the `BenchRoleArn` output as the `BENCH_ROLE_ARN` secret of the
`agent-bench` GitHub environment (and as a Dependabot secret) and
`BenchBucketName` as its `BENCH_BUCKET` variable. The bench calls Anthropic
models on Bedrock, so enable model access in account 1 and check the Bedrock
quotas for the bench model before its first run.

Each role trusts only its own GitHub environment, so jobs in `agent-bench`
can't assume `blocks-github-e2e` and jobs in `e2e` can't assume
`blocks-github-bench`.

### More E2E accounts

PR E2E jobs are spread over a pool of E2E accounts, all behind the same `e2e`
GitHub environment. `.github/actions/e2e-slot` maps each PR to one account (PR
number mod the number of accounts); runs without a PR use account 1. Every pool
account runs this stack unchanged, so every account's role has the same
permissions and trusts the same `e2e` environment. The pool spreads quota; it
does not separate the accounts from each other, so give every pool account the
same account-level guardrails.

To add an account:

1. With credentials for the new account, bootstrap CDK and deploy this stack:

   ```bash
   cd test-infra
   npx cdk bootstrap aws://<e2e-account-id>/us-east-1
   E2E_ACCOUNT_ID=<e2e-account-id> npm run deploy:oidc
   ```

2. Create the `blocks/supabase-e2e` secret in `us-east-1` with the same value
   as in account 1. The role can only read `blocks/supabase-e2e-*` in that
   region.
3. Verify the `E2E_FROM_EMAIL` address as an SES identity in `us-east-1`.
4. Request the same quota increases as the other accounts, in `us-east-1`:
   VPCs per Region (20), Internet gateways per Region (20), Cognito rate of
   UserRead requests (240) and IAM roles per account (3000, which
   `cleanup-stacks.yml` warns against). Edge-optimized REST APIs stay at 120;
   that limit can't be raised, which is why the pool exists.
5. Append the new `RoleArn` to the `AWS_ROLE_ARNS` secret, a JSON array in pool
   order (account 1 first). Set it in the `e2e` environment and as a Dependabot
   secret (Dependabot runs only get Dependabot secrets).
6. Raise `E2E_ACCOUNTS` in `.github/actions/e2e-slot`. `cleanup-stacks.yml`
   builds one cleanup leg per account from that count, and its legs fail if
   `AWS_ROLE_ARNS` has a different length.

Changing the count moves most open PRs to a different account. Their old
stacks stay behind, and the cleanup leg of the old account removes them. Before
you take an account out of the pool, empty it: once the count no longer
includes it, no cleanup leg sweeps it.

CDK deploys from E2E jobs run with the CDK bootstrap execution role. Keep every
pool account limited to E2E test stacks.

`npm test` checks that each trust policy stays pinned to its own environment of
this repo (`e2e` or `agent-bench`) with `StringEquals` and no wildcards, that
the two roles never share one, and that the bench is only added on request.
