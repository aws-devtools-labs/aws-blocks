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
