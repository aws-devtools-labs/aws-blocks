# VPC Support — Design

> **Status:** Implemented (PR #286, branch `feat/vpc-pull-pattern`)

---

**Package:** `@aws-blocks/core` (CDK-level option)
**AWS Services:** Amazon VPC, EC2 (subnets, NAT gateways, security groups, VPC endpoints)

---

## Purpose

Place an AWS Blocks application in a VPC with a single prop on `BlocksStack`/`BlocksBackend`. The framework handles Lambda placement, endpoint provisioning (based on BB requirements), and security group wiring.

---

## API Surface

### BlocksVpcOptions

```typescript
interface BlocksVpcOptions {
  /** The VPC to place Lambdas and VPC-resident resources into. */
  network: ec2.IVpc;

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

### Customer Usage

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const vpc = new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 });

// Simplest: pass VPC, Blocks provisions endpoints automatically
await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, vpc: { network: vpc } },
});

// Bring existing VPC with pre-provisioned endpoints
const sharedVpc = ec2.Vpc.fromLookup(app, 'SharedVpc', { vpcId: 'vpc-abc123' });
await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: { ...BlocksPresets.production, vpc: { network: sharedVpc, provisionEndpoints: false } },
});
```

---

## BB Endpoint Registration

Each Building Block declares what it needs from the VPC by passing a plain
`VpcRequirements` object into the `BuildingBlockScope` constructor. The base
class registers it in a per-stack requirements registry
(`vpc-requirements-registry.ts`); `finalizeVpc` reads the registry at
finalization, deduplicates, and provisions.

### Registration API

```typescript
// A BB passes its requirements to the BuildingBlockScope constructor:
super(id, { parent: scope, vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] } });

interface VpcRequirements {
  gatewayEndpoints?: ec2.GatewayVpcEndpointAwsService[];
  interfaceEndpoints?: ec2.InterfaceVpcEndpointAwsService[];
  /** The BB cannot function without a VPC; when set and no VPC was provided,
   *  the framework lazily derives a default one. */
  requiresVpc?: boolean;
  /** The BB's parent runtime (shared Lambda) must have outbound egress;
   *  validated at synth against the runtime's resolved placement, fails the
   *  build on a mismatch. */
  requiresEgress?: boolean;
}
```

### Per-BB Declarations

| Building Block | VPC requirements |
|----------------|--------------------------------|
| bb-kv-store | `{ gatewayEndpoints: [DYNAMODB] }` |
| bb-distributed-table | `{ gatewayEndpoints: [DYNAMODB] }` |
| bb-file-bucket | `{ gatewayEndpoints: [S3] }` |
| bb-data | `{ interfaceEndpoints: [SECRETS_MANAGER, RDS_DATA] }` |
| bb-async-job | `{ interfaceEndpoints: [SQS] }` |
| bb-agent | `{ interfaceEndpoints: [BEDROCK_RUNTIME] }` |
| bb-knowledge-base | `{ interfaceEndpoints: [BEDROCK_RUNTIME] }` |
| bb-email-client | `{ interfaceEndpoints: [SES] }` |
| bb-app-setting | `{ interfaceEndpoints: [SSM] }` |
| bb-realtime | `{ interfaceEndpoints: [APIGATEWAY] }` |
| bb-auth-cognito | `{ interfaceEndpoints: [SSM] }` |
| bb-auth-oidc | `{ interfaceEndpoints: [SSM] }` |
| bb-distributed-data | `{ requiresEgress: true }` (DSQL over public HTTPS needs Lambda egress) |

> CloudWatch Logs is always provisioned by `finalizeVpc` regardless of BB
> declarations (Lambda needs it for log delivery from within a VPC). The SSM
> interface endpoint is no longer always-on — it flows from BB requirements
> (AppSetting and the auth BBs), so an app that uses neither gets no SSM
> endpoint.

### Always-Added Endpoints

The framework always adds these when `provisionEndpoints !== false`, regardless of BB declarations:

- **CloudWatch Logs** (interface) — Lambda needs it for log delivery from within a VPC
- **S3** (gateway) — free, route-table only; used to pull config/secrets/migrations at cold start

SSM is *not* in this list — it is provisioned only when a BB in scope declares it (AppSetting, the auth BBs).

### Collection and Provisioning

After all BBs are constructed, `finalizeVpc` walks the construct tree, collects all registered gateway and interface endpoints, deduplicates by service name, and provisions them on the VPC. Gateway endpoints are free; interface endpoints cost ~$7.20/month/AZ.

---

## Internal VPC Context

```typescript
interface VpcContext {
  readonly vpc: ec2.IVpc;
  readonly computeSecurityGroup: ec2.ISecurityGroup;
  readonly computeSubnets: ec2.SubnetSelection;
  selectSubnets(role: SubnetRole): ec2.SubnetSelection;
}
```

Set on the scope during `initializeVpc()`. BBs like `bb-data` read this via `getVpcContext(scope)` to discover the shared VPC and place Aurora in the correct subnets.

---

## Testing Strategy

### Persistent Test VPC (Bare Minimum)

The persistent test VPC stack (`test-infra/vpc-test-stack.ts`) contains only:

- VPC with public / private / isolated subnets (2 AZs)
- 1 NAT gateway
- VPC ID output

No pre-provisioned endpoints. No Aurora cluster. No security groups beyond defaults.

The test app provisions its own endpoints via `provisionEndpoints: true`, testing the real auto-detection path end-to-end.

### Per-Test Aurora

The `vpc-smoke` test app instantiates `new Database(scope, 'db')` with **no** `connection` option. The Database BB detects the VPC context and creates its own Aurora Serverless v2 cluster in the shared VPC's isolated subnets. The test runs `SELECT 1` and insert/read operations against this self-provisioned Aurora.

This avoids:
- A persistent Aurora cluster ($50+/month idle costs)
- External secret ARN management
- Cross-stack coupling between test infra and test app

### Test App Structure

```
test-apps/vpc-smoke/
├── aws-blocks/
│   ├── index.ts          # Instantiates KVStore, DistributedTable, FileBucket, AsyncJob, AppSetting, Realtime, AuthCognito, Database, Logger, Metrics, Tracer
│   ├── index.cdk.ts      # Looks up persistent test VPC, passes vpc: { network: vpc, provisionEndpoints: true }
│   └── index.handler.ts  # Re-exports BB instances
└── package.json
```

---

## Phased Implementation

### Phase 1: CDK-level VPC (this PR)

- `vpc` prop on `BlocksStack` / `BlocksBackend`
- `VpcRequirements` passed into the `BuildingBlockScope` constructor, collected in a per-stack registry
- Per-BB endpoint declarations in each BB's CDK constructor
- Finalization: collect + deduplicate + provision endpoints
- Lambda placement in private subnets + security group
- `bb-data` refactor: use shared VPC when available
- `BlocksVpcOptions`: `{ vpc, subnets?, provisionEndpoints? }`

### Phase 2: Per-handler VPC (after configurable compute)

- `VpcNetwork` Building Block
- `network` option on individual compute targets
- Per-handler scope tree walks for requirement collection
