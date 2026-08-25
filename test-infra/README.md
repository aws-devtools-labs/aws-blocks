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

| Resource | Purpose | Cost |
|----------|---------|------|
| VPC (2 AZs, 1 NAT) | Network isolation for Lambda | ~$32/mo (NAT) |
| DynamoDB gateway endpoint | KVStore, DistributedTable | Free |
| S3 gateway endpoint | FileBucket | Free |
| SSM interface endpoint | AppSetting, Auth session secrets | ~$7/mo/AZ |
| Secrets Manager interface endpoint | Database credentials | ~$7/mo/AZ |
| CloudWatch Logs interface endpoint | Lambda log delivery | ~$7/mo/AZ |

## Do NOT Delete

This stack is tagged with `blocks:do-not-delete=true`. Deleting it will break all VPC smoke tests in CI until redeployed.
