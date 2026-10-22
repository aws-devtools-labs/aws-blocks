# test-infra — Persistent Test VPCs

This directory contains infrastructure that is deployed **once** and **not torn down** between test runs.

## Why?

- VPC quota is 5 per region
- VPC creation takes 2–3 minutes
- VPC deletion can fail (Lambda ENIs linger 10–20 min)
- Without a persistent VPC, CI hits quotas on concurrent runs

## Stacks

There are **two** persistent VPC stacks, one per smoke suite, so the two suites
never contend for a single VPC's per-service private-DNS interface endpoints
(AWS permits only one such endpoint per service per VPC). Keeping them separate
lets the two CI lanes run in parallel.

| Stack | Consumed by | CI lane |
|-------|-------------|---------|
| `BlocksTestVpc` | `test-apps/vpc-smoke/` | E2E VPC Smoke (`blocks-test-vpc`) |
| `BlocksComputeTestVpc` | `test-apps/compute-smoke/` | E2E Compute Smoke (`blocks-test-compute`) |

## Usage

### Deploy (one-time)

```bash
cd test-infra
npm install
npx cdk deploy BlocksTestVpc
npx cdk deploy BlocksComputeTestVpc
# or both at once:
npx cdk deploy --all
```

Each stack outputs its VPC ID. Set the `VPC_TEST_VPC_ID` environment variable
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

## Resources Created

Each stack is intentionally bare — a VPC and one NAT gateway, nothing else. It
provisions **no** VPC endpoints and **no** Aurora cluster: each smoke-test app
deploys with `provisionEndpoints: true` so `finalizeVpc` provisions the
endpoints into the app's own (per-PR) stack, exercising the real auto-detection
path end-to-end.

| Resource (per stack) | Purpose | Cost |
|----------------------|---------|------|
| VPC (2 AZs) | Network isolation for the smoke-test app's Lambda | — |
| 1 NAT gateway | Egress for private-with-egress subnets | ~$32/mo |
| Public / private-with-egress / isolated subnets | Cover every placement the app may select | — |
| `VpcId` CfnOutput | Consumed by the app stack via `VPC_TEST_VPC_ID` | — |

Interface/gateway endpoints are **not** here — they are created per-run in each
smoke app's stack.

> **VPC quota note:** these two stacks consume 2 of the region's 5 VPCs. Account
> for that before adding more persistent VPCs here.

## Do NOT Delete

Both stacks are tagged with `blocks:do-not-delete=true`. Deleting either will
break the corresponding smoke tests in CI until redeployed.

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
