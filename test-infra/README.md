# test-infra — Persistent Test VPC

This directory contains infrastructure that is deployed **once** and **not torn down** between test runs.

## Why?

- VPC quota is 5 per region
- VPC creation takes 2–3 minutes
- VPC deletion can fail (Lambda ENIs linger 10–20 min)
- Without a persistent VPC, CI hits quotas on concurrent runs

## Usage

### Deploy (one-time)

```bash
cd test-infra
npm install
npx cdk deploy
```

The stack outputs the VPC ID. Set the `VPC_TEST_VPC_ID` environment variable for downstream test stacks:

```bash
export VPC_TEST_VPC_ID=$(aws cloudformation describe-stacks \
  --stack-name BlocksTestVpc \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
  --output text)
```

### Reference from test apps

The `test-apps/vpc-smoke/` app reads the VPC ID from `VPC_TEST_VPC_ID` env var or `-c vpcId=vpc-xxx` CDK context:

```bash
cd test-apps/vpc-smoke
VPC_TEST_VPC_ID=vpc-abc123 NODE_OPTIONS="--conditions=cdk" npx cdk deploy
```

## Resources Created

This stack is intentionally bare — a VPC and one NAT gateway, nothing else. It
provisions **no** VPC endpoints and **no** Aurora cluster: the `vpc-smoke` test
app deploys with `provisionEndpoints: true` so `finalizeVpc` provisions the
endpoints into the app's own (per-PR) stack, exercising the real auto-detection
path end-to-end.

| Resource | Purpose | Cost |
|----------|---------|------|
| VPC (2 AZs) | Network isolation for the smoke-test app's Lambda | — |
| 1 NAT gateway | Egress for private-with-egress subnets | ~$32/mo |
| Public / private-with-egress / isolated subnets | Cover every placement the app may select | — |
| `VpcId` CfnOutput | Consumed by the app stack via `VPC_TEST_VPC_ID` | — |

Interface/gateway endpoints are **not** here — they are created per-run in the
`vpc-smoke` app stack.

## Do NOT Delete

This stack is tagged with `blocks:do-not-delete=true`. Deleting it will break all VPC smoke tests in CI until redeployed.

# GitHub OIDC role for E2E (`github-oidc-stack.ts`)

PR E2E jobs, including Dependabot PRs, run third-party code with AWS
credentials. They therefore run in a **dedicated E2E account** that holds only
test stacks.

This stack creates, in that account:

| Resource | Purpose |
|----------|---------|
| GitHub OIDC identity provider | Lets GitHub Actions exchange its OIDC token for AWS credentials |
| `blocks-github-e2e` role | Assumable only by jobs in this repo's `e2e` GitHub environment; CDK deploys, E2E stack/bucket cleanup, Cognito admin calls, Supabase test secret |

It is deployed **by hand, once per account**, not by CI:

```bash
cd test-infra
npx cdk bootstrap        # once per account/region
E2E_ACCOUNT_ID=<e2e-account-id> npm run deploy:oidc
```

The stack refuses to synthesize unless `E2E_ACCOUNT_ID` is set and matches the
account of the active credentials.

Set the `RoleArn` output as the `AWS_ROLE_ARN` secret of the `e2e` GitHub
environment and as a Dependabot secret. Deploy this stack only into the
dedicated E2E account.
