# VPC Support

## Cost Information

VPC support adds recurring AWS costs. Understand these before enabling:

| Resource | Cost | Notes |
|---|---|---|
| NAT Gateway | ~$32/month per gateway + $0.045/GB processed | Required for Lambda internet access from private subnets. 1 per AZ recommended for HA. |
| Interface VPC Endpoints | ~$7.20/month per endpoint per AZ | Auto-provisioned per BB (SQS, Secrets Manager, Bedrock, etc.). Adds up quickly with many BBs. |
| Gateway VPC Endpoints (S3, DynamoDB) | Free | No additional cost. |

**Example:** A 2-AZ app using KVStore + Database + AsyncJob + AppSetting:
- 1 NAT Gateway: ~$32/month
- 4 interface endpoints × 2 AZs × $7.20: ~$57.60/month
- 2 gateway endpoints: $0
- **Total VPC overhead: ~$90/month**

> **Most AWS Blocks apps don't need a VPC.** All Blocks communicate with AWS services over HTTPS through public endpoints by default. A VPC adds cost and complexity — only use one when you have a specific requirement for it.

## When to Use a VPC

**Use a VPC when:**
- You need to connect to VPC-bound resources (ElastiCache, existing RDS clusters, internal services)
- Compliance requires network-level isolation (no public internet egress for Lambda)
- You're integrating with an organization's existing VPC topology
- You need security group rules to restrict traffic between services

**Don't use a VPC when:**
- You're building a standard web app with Blocks' built-in data stores (KVStore, DistributedTable, DistributedDatabase)
- Your only AWS interactions are through Blocks (they handle connectivity automatically)
- You want to minimize cost and operational complexity
- You're prototyping or building an MVP

## Usage

Place your app in a VPC by passing a standard CDK VPC to `BlocksStack` or `BlocksBackend`:

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const vpc = new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 });

await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  vpc: { vpc },
});
```

AWS Blocks handles:
- **Lambda placement** in private subnets (configurable via `subnets`)
- **VPC endpoint provisioning** based on which BBs are in scope (DynamoDB, S3, SSM, Secrets Manager, SQS, Bedrock, etc.)
- **Security group wiring** (e.g., Lambda → Aurora on port 5432)

### Bring Your Own VPC

For a shared or separately managed VPC:

```typescript
const sharedVpc = ec2.Vpc.fromLookup(app, 'SharedVpc', { vpcId: 'vpc-abc123' });
await BlocksStack.create(app, stackName, {
  ...,
  vpc: { vpc: sharedVpc },  // Blocks provisions endpoints automatically
});
```

### Externally Managed Endpoints

If VPC endpoints are managed separately (e.g., in another stack or by another team):

```typescript
await BlocksStack.create(app, stackName, {
  ...,
  vpc: { vpc: sharedVpc, provisionEndpoints: false },
});
```

## Configuration Options

```typescript
interface BlocksVpcOptions {
  /** The VPC to place Lambdas and VPC-resident resources into. */
  vpc: ec2.IVpc;

  /**
   * Subnet selection for Lambda and all Blocks-managed compute placement.
   * @default { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
   */
  subnets?: ec2.SubnetSelection;

  /**
   * Whether to auto-provision VPC endpoints based on BB registrations.
   * Set to `false` to disable (e.g., when using a shared VPC that already has endpoints).
   * @default true
   */
  provisionEndpoints?: boolean;
}
```

## Further Reading

See [VPC-DESIGN.md](./VPC-DESIGN.md) for detailed implementation design, including per-BB endpoint declarations, the internal finalization process, and testing strategy.
