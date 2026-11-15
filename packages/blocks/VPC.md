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
- 5 interface endpoints × 2 AZs × $7.20: ~$72/month
  (SQS from AsyncJob, Secrets Manager + RDS Data from Database, SSM from
  AppSetting, and the always-on CloudWatch Logs that `finalizeVpc` provisions
  for every VPC-attached deployment)
- 2 gateway endpoints (S3, DynamoDB): $0
- **Total VPC overhead: ~$104/month**

Endpoints other than CloudWatch Logs are provisioned only from the requirements
the BBs in scope declare — an app without AppSetting or an auth BB gets no SSM
endpoint, dropping this example to ~$97/month. Only CloudWatch Logs (Lambda log
delivery) and the free S3 gateway endpoint (config/secrets/migrations at cold
start) are always added.

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
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const vpc = new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 });

await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, vpc: { network: vpc } },
});
```

AWS Blocks handles:
- **Lambda placement** in private subnets (configurable via `subnets`)
- **VPC endpoint provisioning** based on which BBs are in scope (DynamoDB, S3, SSM, Secrets Manager, SQS, Bedrock, etc.)
- **Security group wiring** (e.g., Blocks Lambda → endpoints on port 443, rotation Lambda → Aurora on port 5432)

### Bring Your Own VPC

For a shared or separately managed VPC, look it up by ID with `ec2.Vpc.fromLookup`.
`fromLookup` must be called inside a `Stack` scope (not the `App`) and the stack it
lives in needs an explicit `env` (account + region) so CDK can perform the lookup.
`BlocksStack.create` wires VPC placement during construction, so the VPC has to be
resolved before that call — host the lookup in a small sibling stack and pass the
resolved `IVpc` into `BlocksStack`:

```typescript
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// fromLookup needs a Stack scope with an explicit env; this sibling stack is
// just a container for the lookup and holds no resources of its own.
const lookupStack = new cdk.Stack(app, `${stackName}-vpc-ref`, { env });
const sharedVpc = ec2.Vpc.fromLookup(lookupStack, 'SharedVpc', { vpcId: 'vpc-abc123' });

await BlocksStack.create(app, stackName, {
  ...,
  defaults: { ...BlocksPresets.production, vpc: { network: sharedVpc } },  // Blocks provisions endpoints automatically
});
```

### Externally Managed Endpoints

If VPC endpoints are managed separately (e.g., in another stack or by another team):

```typescript
await BlocksStack.create(app, stackName, {
  ...,
  defaults: { ...BlocksPresets.production, vpc: { network: sharedVpc, provisionEndpoints: false } },
});
```

Your endpoints' security groups must then admit everything Blocks places in the VPC:
the Blocks Lambda security group, and any compute a BB provisions itself. Today that
is the Database rotation Lambda, which reaches the Secrets Manager endpoint from its
own security group. Synth emits a `blocks:vpc:endpoint-client-unadmitted` warning
naming that security group by construct path. Blocks cannot tell whether your
endpoint already admits the group, so it does not fail the synth.

That group is created by the first deploy, so the first rotation always runs before
you can admit it: it fails, and the deploy waits five minutes for it before carrying
on. Deploying once with rotation off does not avoid this, because that creates no
rotation security group to admit. The sequence is:

1. Deploy. The first rotation fails and the deploy takes about five minutes longer.
   The `RotationFailed` CloudTrail event it leaves is expected at this step.
2. Read the rotation security group's id from the stack output whose name ends in
   `RotationSgId`.
3. Allow inbound 443 from that group on your Secrets Manager endpoint's security
   group.
4. Wait. Secrets Manager reattempts the pending rotation and it succeeds once the
   rule is in place; the secret's last-rotated date advances. Do not call
   `rotate-secret` to hurry it — while a reattempt is pending that call is refused
   with "A previous rotation isn't complete".

A rotation that cannot reach Secrets Manager shows up in the rotation Lambda's log
and as a `RotationFailed` CloudTrail event.

The warning keeps firing on every synth once you have added the rule, because Blocks
still cannot see your endpoint's rules. Acknowledge it in your app, which covers
that scope and every scope under it:

```typescript
Annotations.of(app).acknowledgeWarning(
  'blocks:vpc:endpoint-client-unadmitted',
  'Secrets Manager endpoint admits the Database rotation security group on 443',
);
```

Pass the id exactly as above. The id the CDK CLI prints under the warning is
prefixed (`Annotation::blocks:vpc:endpoint-client-unadmitted`) and does not match
here.

## Configuration Options

```typescript
interface BlocksVpcOptions {
  /** The VPC to place Lambdas and VPC-resident resources into. */
  network: ec2.IVpc;

  /**
   * Subnet selection for Lambda and all Blocks-managed compute placement.
   * Any subnets you select must belong to `network`; this is not validated at
   * synth (CDK can't check an imported subnet), so a mismatch surfaces as a
   * CloudFormation error at deploy.
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
