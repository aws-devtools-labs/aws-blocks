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
credentials. They therefore run in a **dedicated E2E account** that holds only
test stacks.

This stack creates, in that account:

| Resource | Purpose |
|----------|---------|
| GitHub OIDC identity provider | Lets GitHub Actions exchange its OIDC token for AWS credentials (skipped if `GITHUB_OIDC_PROVIDER_ARN` is set) |
| `blocks-github-e2e` role | Assumable only by jobs in this repo's `e2e` GitHub environment; CDK deploys, E2E stack/bucket cleanup, the `cleanup-stacks.yml` quota sweeps (REST APIs, API Gateway CloudWatch roles, CloudFront response headers policies), Cognito admin calls, Supabase test secret |

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

Set the `RoleArn` output as the `AWS_ROLE_ARN` secret of the `e2e` GitHub
environment and as a Dependabot secret. Deploy this stack only into the
dedicated E2E account.

### More E2E accounts

PR E2E jobs can be spread over a pool of E2E accounts. All of them sit behind
the same `e2e` GitHub environment: deploy this stack unchanged into each
account, so every account's role trusts only `e2e`.

```bash
E2E_ACCOUNT_ID=<e2e-account-id> npm run deploy:oidc
```

Store each account's `RoleArn` as `AWS_ROLE_ARN_<n>` in the `e2e` environment
and as a Dependabot secret (Dependabot runs only get Dependabot secrets), where
`<n>` is the account's number in the pool (`aws-blocks+github-e2e-<n>@amazon.com`).
Each account also needs the Supabase test secret, the SES sender and the quota
increases that the first account has.

CDK deploys from E2E jobs run with the CDK bootstrap execution role. Keep this
account limited to E2E test stacks.

`npm test` checks that the trust policy stays pinned to this repo's `e2e`
environment with `StringEquals` and no wildcards.
