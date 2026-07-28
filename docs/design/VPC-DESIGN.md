# BB-vpc-network — Preliminary Design

> **⚠️ PRELIMINARY** — This document is a design proposal for internal review. API surface, resource topology, and naming may change before implementation. Do not implement against this document.

---

**Package:** `@aws-blocks/bb-vpc-network`
**Type:** Infrastructure-only (no runtime methods) + CDK-level option
**AWS Services:** Amazon VPC, EC2 (subnets, NAT gateways, security groups, VPC endpoints)

---

## Purpose

Today, placing an AWS Blocks application in a VPC requires L1 escape hatches (`CfnFunction.vpcConfig`), manual IAM policy grants, manual VPC endpoint creation, and manual security group wiring. The Database BB (`bb-data`) creates its **own** isolated VPC internally — meaning it cannot communicate with the shared Lambda handler or other BBs without manual VPC peering.

This BB provides:
1. **CDK-level VPC** — a `vpc` option on `BlocksStack`/`BlocksBackend` that places the shared Lambda handler in a VPC and propagates network context to child BBs (the 80% use case).
2. **VPC as a Building Block** — a `VpcNetwork` class for per-handler granularity when per-handler compute targets land (future).

Both approaches auto-provision VPC endpoints, auto-wire security groups, and let BBs declare their subnet placement requirements — eliminating the manual wiring tax.

> **Available today:** A working escape-hatch pattern exists in `apps/example-vpc/` using CDK Mixins to apply VPC placement to all Lambdas after stack creation. See [Appendix: Current Workaround](#appendix-current-workaround-escape-hatch) for details. The first-class feature proposed here would replace that manual wiring with a single prop.

---

## API Surface

### Types

```typescript
// packages/core/src/cdk/vpc-types.ts

/**
 * Subnet role — BBs declare what kind of subnet they need.
 * The VPC maps roles to actual subnet selections.
 */
export type SubnetRole = 'private-with-egress' | 'isolated' | 'public';

/**
 * Options for VPC integration on BlocksStack / BlocksBackend.
 */
export interface BlocksVpcOptions {
  /**
   * The VPC to place Lambdas and VPC-resident resources into.
   * Create this however you like — standard CDK:
   *
   * @example
   * const vpc = new ec2.Vpc(stack, 'AppVpc', { maxAzs: 2, natGateways: 1 });
   * // or
   * const vpc = ec2.Vpc.fromLookup(stack, 'SharedVpc', { vpcId: 'vpc-abc123' });
   */
  vpc: ec2.IVpc;

  /**
   * Subnet selection for Lambda placement.
   * @default { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
   */
  lambdaSubnets?: ec2.SubnetSelection;

  /**
   * VPC endpoints to provision. When set to 'auto' (the default), endpoints
   * are determined by the BBs in scope — each BB reports its VPC requirements
   * to the Scope chain at construction time, and the framework provisions the
   * necessary endpoints automatically. Set to 'none' to disable (e.g., when
   * using a shared VPC that already has endpoints), or provide an explicit list
   * to override auto-detection.
   *
   * @default 'auto'
   */
  endpoints?: 'auto' | 'none' | VpcEndpointConfig[];
}

/**
 * Explicit VPC endpoint configuration (for manual override).
 */
export interface VpcEndpointConfig {
  service: string;
  type?: 'gateway' | 'interface';
}
```

### BlocksStack / BlocksBackend API

```typescript
export interface BlocksStackProps extends StackProps {
  backendHandlerPath: string;
  backendCDKPath: string;

  /**
   * Place the app's compute and VPC-resident resources in a VPC.
   * Pass a standard CDK VPC — Blocks handles Lambda placement,
   * endpoint provisioning (based on BB requirements), and SG wiring.
   *
   * Omit for no VPC (default — Lambda runs in AWS-managed network).
   */
  vpc?: BlocksVpcOptions;
}

// BlocksBackendProps receives the same `vpc` field.
```

### Customer usage

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';

// Customer creates VPC however they want — standard CDK, nothing Blocks-specific
const vpc = new ec2.Vpc(app, 'AppVpc', {
  maxAzs: 2,
  natGateways: 1,
  subnetConfiguration: [
    { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
    { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  ],
});

// Pass it to Blocks — one prop, Blocks does the rest
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  vpc: { vpc },
});

// Or bring an existing VPC (shared/platform-team-managed)
const sharedVpc = ec2.Vpc.fromLookup(app, 'SharedVpc', { vpcId: 'vpc-abc123' });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  vpc: { vpc: sharedVpc, endpoints: 'none' }, // shared VPC already has endpoints
});
```

### VPC as a Building Block (Phase 2 — after configurable compute)

When per-handler compute targets land, a `VpcNetwork` BB would provide convenience for customers who want Blocks to manage the VPC lifecycle and enable per-handler VPC opt-in:

```typescript
// Future — creates and manages a VPC internally, exposes ec2.IVpc
const network = new VpcNetwork(scope, 'internal', { maxAzs: 2, natGateways: 1 });

// Per-handler opt-in
export const publicApi = new ApiNamespace(scope, 'public', handler);         // no VPC
export const adminApi = new ApiNamespace(scope, 'admin', handler, { network }); // in VPC
```

This is deferred to Phase 2. See [#203](https://github.com/aws-devtools-labs/aws-blocks/issues/203) Option 2.

### BB Integration Protocol

```typescript
// Proposed addition to @aws-blocks/core/cdk — Scope

export abstract class Scope extends Construct {
  // ... existing members ...

  /**
   * Resolved VPC context for this scope. Set by the CDK-level VPC
   * option or by a VpcNetwork BB passed via `network`. BBs read this
   * to determine their VPC placement.
   *
   * @internal
   */
  get vpcContext(): VpcContext | undefined {
    // Walk up the construct tree looking for VpcContext
  }
}

/**
 * Internal VPC context propagated through the construct tree.
 * Not exported to customers — BBs consume it internally.
 * @internal
 */
export interface VpcContext {
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  selectSubnets(role: SubnetRole): ec2.SubnetSelection;
  addEndpoint(service: string, type: 'gateway' | 'interface'): void;
  allowIngressFrom(source: ec2.ISecurityGroup, port: ec2.Port, description: string): void;
}
```

### Subnet Role Declaration (BB-side)

```typescript
// Example: how Database declares its subnet requirement
// packages/bb-data/src/infra.ts (proposed change)

export function materialize(
  scope: Construct,
  name: string,
  options: AuroraInfraConfig,
): AuroraInfraOutputs {
  // Check if parent scope provides a VPC
  const vpcContext = (scope as any).vpcContext as VpcContext | undefined;

  let vpc: ec2.IVpc;
  let securityGroup: ec2.ISecurityGroup;

  if (vpcContext) {
    // Use the provided VPC — place Aurora in isolated subnets
    vpc = vpcContext.vpc;
    securityGroup = new ec2.SecurityGroup(scope, `${name}Sg`, {
      vpc,
      description: `Security group for ${name} Aurora cluster`,
      allowAllOutbound: false,
    });
    // Auto-wire: allow Lambda SG → Aurora on 5432
    vpcContext.allowIngressFrom(
      vpcContext.lambdaSecurityGroup,
      ec2.Port.tcp(DEFAULT_POSTGRES_PORT),
      'Lambda to Aurora'
    );
    // Request Secrets Manager endpoint
    vpcContext.addEndpoint('com.amazonaws.{region}.secretsmanager', 'interface');
  } else {
    // Standalone fallback: create isolated VPC (current behavior)
    vpc = new ec2.Vpc(scope, `${name}Vpc`, { /* ... current config ... */ });
    securityGroup = new ec2.SecurityGroup(scope, `${name}Sg`, { /* ... */ });
  }

  // ... rest of materialization unchanged ...
}
```

---

## Error Constants

```typescript
// packages/bb-vpc-network/src/errors.ts

export const VpcNetworkErrors = {
  /**
   * Thrown when subnet IDs in fromExisting() don't belong to the specified VPC.
   */
  SubnetVpcMismatch: 'SubnetVpcMismatch',

  /**
   * Thrown when no subnets of the requested role are available.
   * e.g., requesting 'isolated' but VPC only has private-with-egress subnets.
   */
  NoSubnetsForRole: 'NoSubnetsForRole',

  /**
   * Thrown when CIDR is invalid or overlaps with existing VPCs in the account.
   * (Detected at synth time only for obvious conflicts.)
   */
  InvalidCidr: 'InvalidCidr',

  /**
   * Thrown when VPC endpoint auto-provisioning fails because the service
   * is not available in the target region.
   */
  EndpointNotAvailable: 'EndpointNotAvailable',
} as const;
```

---

## Infrastructure (CDK)

### Resources Created (new VPC, `size: 'default'`)

| Resource | Purpose | Count |
|----------|---------|-------|
| VPC | Network boundary | 1 |
| Internet Gateway | Outbound from public subnets | 1 |
| NAT Gateway | Outbound from private subnets | 2 (one per AZ) |
| Public subnets | NAT gateway placement | 2 |
| Private subnets (with egress) | Lambda, ECS tasks | 2 |
| Isolated subnets | Aurora, ElastiCache | 2 |
| Route tables | Subnet routing | 6 (one per subnet) |
| Security group (Lambda) | Attached to Lambda ENI | 1 |
| VPC endpoints | Service access without NAT | Auto-detected |

### Size Presets

| Preset | AZs | NAT Gateways | Estimated monthly cost (NAT only) | Use case |
|--------|-----|--------------|------------------------------------|----------|
| `'dev'` | 1 | 1 | ~$32 + data | Sandbox, dev, experimentation. No HA. |
| `'default'` | 2 | 2 | ~$64 + data | Production-ready. Survives single AZ failure. |
| `'full'` | 3 | 3 | ~$96 + data | Maximum availability. |

Each preset maintains NATs = AZs (one per AZ) for full redundancy within its tier. No weird half-states where some AZs lack outbound connectivity.

### VPC Endpoint Auto-Detection

During `finalizeConfigRegistry` (after all BBs are constructed), the VPC BB walks the construct tree and detects which BB types are present:

| BB Present | Endpoint Provisioned | Type |
|------------|---------------------|------|
| KVStore / DistributedTable | `com.amazonaws.{region}.dynamodb` | Gateway |
| FileBucket | `com.amazonaws.{region}.s3` | Gateway |
| Database | `com.amazonaws.{region}.secretsmanager` | Interface |
| Database | `com.amazonaws.{region}.rds-data` | Interface |
| AppSetting | `com.amazonaws.{region}.ssm` | Interface |
| (Always when VPC enabled) | `com.amazonaws.{region}.logs` | Interface |

Gateway endpoints are free. Interface endpoints cost ~$7.20/month/AZ + data.

### Security Group Auto-Wiring

The VPC context maintains a registry of security groups. When BBs request connectivity:

- **Lambda → Aurora (5432):** Database BB calls `vpcContext.allowIngressFrom(lambdaSG, Port.tcp(5432), ...)`
- **Lambda → ElastiCache (6379):** Future cache BB would do the same
- **Lambda → Internet:** Private subnet route table → NAT gateway (already wired)

No customer-facing API for security groups. The framework infers all rules from BB dependencies.

### Lambda VPC Configuration

When `vpc` is set on the stack, `setupBlocksInfra()` adds to the Lambda function:

```typescript
const handler = new lambda.NodejsFunction(scope, 'Handler', {
  // ... existing config ...
  vpc: resolvedVpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  securityGroups: [lambdaSecurityGroup],
});
```

The Lambda execution role automatically receives `ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, and `ec2:DeleteNetworkInterface` permissions (CDK adds these when `vpc` is specified).

---

## Mock Implementation

```typescript
// packages/bb-vpc-network/src/index.mock.ts

// VpcNetwork is infrastructure-only — no runtime methods.
// The mock is a no-op.
export {};
```

The VPC BB has **no runtime behavior**. It only provisions infrastructure at deploy time. The mock layer exports nothing.

### Mock-time Network Isolation (Future Consideration)

A future enhancement could simulate network isolation in local dev:
- BBs marked as "VPC-only" could refuse connections from non-VPC scopes
- Simulated DNS resolution failures for services without endpoints

This is **not** in scope for v1. Local dev always has full network access.

---

## Mock vs AWS Parity Gap

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No network isolation locally | Code that would fail due to missing VPC endpoints succeeds in dev | Recommend `npm run sandbox` for VPC smoke testing |
| No NAT gateway latency | Outbound calls are faster locally | Non-functional; no impact on correctness |
| No ENI cold start penalty | Lambda cold starts are faster locally (~1-5s difference in VPC) | Document; VPC cold start visible in sandbox |
| No security group enforcement | All BB-to-BB communication succeeds locally | Security groups are additive (deny-nothing model for BB wiring) |
| No DNS resolution differences | Local DNS resolves everything; VPC may not without endpoints | Endpoint auto-detection prevents this class of error |

---

## Usage Examples

### CDK-level VPC (simplest — create for me)

```typescript
// cdk.ts
import { BlocksStack } from '@aws-blocks/core/cdk';

const app = new cdk.App();
await BlocksStack.create(app, 'MyApp', {
  backendHandlerPath: './src/handler.ts',
  backendCDKPath: './src/infra.ts',
  vpc: true, // Creates 'default' VPC, auto-detects endpoints
});
```

```typescript
// infra.ts — BBs work exactly as before, no changes needed
import { Database } from '@aws-blocks/bb-data/cdk';
import { KVStore } from '@aws-blocks/bb-kv-store/cdk';

export default (scope) => {
  const db = new Database(scope, 'main');
  const cache = new KVStore(scope, 'sessions');
  // Database uses the stack VPC (isolated subnets) automatically
  // KVStore triggers DynamoDB gateway endpoint automatically
  // Security groups auto-wired: Lambda → Aurora on 5432
};
```

### CDK-level VPC (custom sizing)

```typescript
await BlocksStack.create(app, 'MyApp', {
  backendHandlerPath: './src/handler.ts',
  backendCDKPath: './src/infra.ts',
  vpc: {
    size: 'full',
    cidr: '10.1.0.0/16',
    endpoints: 'auto',
  },
});
```

### Bring-your-own VPC (shared/platform-managed)

```typescript
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const sharedVpc = ec2.Vpc.fromLookup(app, 'SharedVpc', { vpcId: 'vpc-abc123' });

await BlocksStack.create(app, 'MyApp', {
  backendHandlerPath: './src/handler.ts',
  backendCDKPath: './src/infra.ts',
  vpc: { vpc: sharedVpc, endpoints: 'none' }, // shared VPC already has endpoints
});
```

### VPC as a Building Block (per-handler, future)

```typescript
// infra.ts
import { VpcNetwork } from '@aws-blocks/bb-vpc-network/cdk';
import { Database } from '@aws-blocks/bb-data/cdk';

export default (scope) => {
  // Create a dedicated VPC for the data tier
  const dataVpc = new VpcNetwork(scope, 'data-tier', { size: 'dev' });

  // Database uses this specific VPC instead of the CDK-level one
  const db = new Database(scope, 'main', { network: dataVpc });
};
```

### Mixed: Stack VPC + some handlers outside (future, per-handler compute)

```typescript
// When per-handler compute targets land:
import { ApiNamespace } from '@aws-blocks/core/cdk';
import { VpcNetwork } from '@aws-blocks/bb-vpc-network/cdk';

export default (scope) => {
  // Public API — no VPC (avoids NAT cost for public endpoints)
  const publicApi = new ApiNamespace(scope, 'public');

  // Internal API — in VPC (needs Aurora access)
  const internalApi = new ApiNamespace(scope, 'internal', {
    network: scope.vpcContext, // inherits CDK-level VPC
  });

  const db = new Database(scope, 'main'); // auto-placed in stack VPC
};
```

### BlocksBackend (existing stack integration)

```typescript
import * as cdk from 'aws-cdk-lib';
import { BlocksBackend } from '@aws-blocks/core/cdk';

const app = new cdk.App();
const stack = new cdk.Stack(app, 'MyInfra');

const blocks = await BlocksBackend.create(stack, 'Blocks', {
  backendHandlerPath: './src/handler.ts',
  backendCDKPath: './src/infra.ts',
  vpc: { size: 'dev' }, // VPC created within the BlocksBackend construct
});
```

---

## bb-data Refactor Plan

The Database BB currently creates its own VPC in `materialize()`. The refactor:

1. **Check for VPC context on the parent scope** — walk up the scope chain looking for a registered VPC (placed by the CDK-level `vpc` prop or a future `VpcNetwork` BB)
2. **If present:** use the provided VPC, place Aurora in isolated subnets, register security group rules
3. **If absent:** fall back to creating an isolated VPC internally (current behavior, for standalone usage)
4. **Remove `natGateways: 0`** from the fallback path — the standalone VPC doesn't need NAT (Data API is HTTP-based, accessed via VPC endpoint or public internet depending on mode)

This is a **backward-compatible** change. Existing apps without `vpc` continue to work. Apps that add `vpc: true` get Database placed in the shared VPC automatically.

---

## BB VPC Requirement Registration

Each Building Block declares what VPC resources it needs via `registerVpcRequirements()` in its CDK constructor. These declarations are collected at finalization time and replayed against the actual VPC construct.

### Registration API

```typescript
// Added to Scope (core/cdk)
protected registerVpcRequirements(requirements: VpcRequirements): void;

interface VpcRequirements {
  /** Endpoints this BB needs to function inside a VPC. */
  endpoints?: VpcEndpointRequirement[];
  /** Subnet role for VPC-resident resources (e.g., Aurora needs 'isolated'). */
  subnetRole?: SubnetRole;
}

interface VpcEndpointRequirement {
  /** AWS service identifier (e.g., 'dynamodb', 'secretsmanager', 'rds-data'). */
  service: string;
  /** Endpoint type. Gateway endpoints are free; interface endpoints cost ~$7/mo per AZ. */
  type: 'gateway' | 'interface';
}
```

### Per-BB declarations

```typescript
// KVStore CDK constructor
this.registerVpcRequirements({
  endpoints: [{ service: 'dynamodb', type: 'gateway' }],
});

// Database CDK constructor
this.registerVpcRequirements({
  endpoints: [
    { service: 'secretsmanager', type: 'interface' },
    { service: 'rds-data', type: 'interface' },
  ],
  subnetRole: 'isolated',
});

// FileBucket CDK constructor
this.registerVpcRequirements({
  endpoints: [{ service: 's3', type: 'gateway' }],
});

// AsyncJob CDK constructor
this.registerVpcRequirements({
  endpoints: [{ service: 'sqs', type: 'interface' }],
});
```

### Collection and provisioning

After all BBs are constructed, the VPC finalization step (triggered by the CDK-level `vpc` prop) walks the scope tree, collects all registered requirements, deduplicates endpoints, and provisions them:

```typescript
// In BlocksStack/BlocksBackend finalization (pseudocode)
const requirements = collectVpcRequirements(this); // walks scope tree
const endpoints = deduplicateEndpoints(requirements.flatMap(r => r.endpoints));

for (const ep of endpoints) {
  if (ep.type === 'gateway') {
    vpc.addGatewayEndpoint(ep.service, { service: gatewayServiceFor(ep.service) });
  } else {
    vpc.addInterfaceEndpoint(ep.service, { service: interfaceServiceFor(ep.service) });
  }
}
```

### Why per-BB registration (not centralized map)

The spike (`vpc-utils.ts`) used a centralized `BLOCK_ENDPOINT_MAP`. That works for first-party BBs, but breaks for customer-authored BBs and future blocks. Per-BB registration means:
- Customer BBs can declare their own VPC needs
- The framework doesn't need a hardcoded list
- Adding a new BB doesn't require updating a central file

### Multi-compute readiness

When per-handler compute lands, each compute target walks its own subtree of BBs, collects their requirements, and provisions against whatever VPC that compute target belongs to. The registration API doesn't change — only the collection scope narrows from "whole stack" to "BBs attached to this handler."

---

---

## Phased Implementation

### Phase 1: CDK-level VPC (this PR)

- `vpc` prop on `BlocksStack` / `BlocksBackend`
- `registerVpcRequirements()` on `Scope`
- Per-BB endpoint declarations in each BB's CDK constructor
- Finalization: collect + deduplicate + provision endpoints
- Lambda placement in private subnets + IAM grant
- `bb-data` refactor: use shared VPC when available
- Accept `ec2.IVpc` via `vpc` prop
- Design doc at `docs/design/VPC-DESIGN.md`
- Tests in `test-apps/vpc-smoke/`

### Phase 2: Per-handler VPC (after configurable compute)

- `VpcNetwork` Building Block
- `network` option on individual `ApiNamespace` / compute targets
- Per-handler scope tree walks for requirement collection
- See [#203](https://github.com/aws-devtools-labs/aws-blocks/issues/203) Option 2

---

## Testing Strategy

### Approach: Persistent test VPC

VPC deployments are slow (~3-5 min) and subject to restrictive quotas (5 VPCs per region by default, endpoint limits). A persistent "test VPC" stack avoids:
- Flaky deploys from quota contention
- 3-5 min overhead on every test run for VPC creation
- Orphaned VPCs from failed teardowns

The test VPC stack deploys once (or is refreshed infrequently) and the `vpc-smoke` test app references it via `fromExisting`. Test resources (Lambdas, tables, etc.) are created/destroyed per test run inside the persistent VPC — no cross-test contamination because Blocks' `fullId` generates unique resource names.

### Test scope

The VPC smoke tests don't replicate the full comprehensive E2E suite. They verify that each BB has **basic functionality when deployed in a VPC** — i.e., the VPC endpoint wiring is correct and the BB can reach its backing service. One happy-path assertion per BB is sufficient.

### Test infrastructure

```
test-apps/vpc-smoke/
├── aws-blocks/
│   ├── index.ts          # Instantiates one of each VPC-relevant BB
│   ├── index.cdk.ts      # Uses vpc: { existing: ... } referencing the persistent test VPC
│   └── index.handler.ts
├── test/
│   └── e2e.test.ts       # One basic operation per BB (get, put, query, publish, etc.)
└── package.json
```

See [Appendix: Test Infrastructure](#appendix-test-infrastructure) for persistent VPC stack details.

---

## Open Questions

1. **Should `vpc: true` be the default for new projects?** NAT gateways cost money (~$64/month minimum). Defaulting to VPC placement would surprise customers with unexpected costs. Proposal: keep `undefined` (no VPC) as default, but warn when Database BB is used without a CDK-level VPC (since it creates its own anyway).

2. **How does this interact with sandbox mode?** Sandbox deploys should use `size: 'dev'` (1 AZ, 1 NAT) regardless of what the customer specifies, to reduce cost. Should the framework auto-downgrade, or leave it to the customer?

3. **VPC endpoint cost visibility:** Interface endpoints are ~$7.20/month/AZ. Auto-provisioning could silently add $30-50/month. Should the framework emit a cost estimate during synth? Or just document it?

4. **Multi-VPC peering:** If a customer creates multiple `VpcNetwork` BBs, should the framework auto-peer them? Or is that an escape-hatch scenario? Proposal: no auto-peering in v1. Document the pattern for customers who need it.

5. **IPv6:** Should the VPC support dual-stack? IPv6-only Lambdas avoid NAT costs entirely. This could be a future `ipv6: true` option but adds complexity.

6. **`network` option on BBs:** The proposed `network: VpcNetwork` option on Database (and future BBs) — should this be a first-class option on all BBs, or only BBs that actually need VPC placement? Proposal: only BBs with a `SubnetRole` requirement accept `network`.

7. **Endpoint deduplication:** If the same endpoint is requested by multiple BBs (e.g., two Databases both need Secrets Manager endpoint), CDK will error on duplicate construct IDs. The `VpcContext.addEndpoint()` method must deduplicate. Implementation: maintain a `Set<string>` of provisioned endpoints.

8. **Cold start impact:** VPC Lambdas have ~1-10s additional cold start for ENI attachment. Should the BB auto-enable Provisioned Concurrency or SnapStart to mitigate? Proposal: no — keep it opt-in, document the tradeoff.

9. **`fromExisting` validation:** Should the CDK layer validate that provided subnet IDs actually exist and belong to the VPC? This requires a custom resource (API call at deploy time). Proposal: rely on CloudFormation's built-in validation (deploy-time error if subnets are wrong) — no custom resource needed.

10. **Naming: `VpcNetwork` vs `Network` vs `Vpc`:** `VpcNetwork` is explicit about the AWS primitive. `Network` is more abstract (could support non-VPC networking in the future). `Vpc` is shortest but might conflict with CDK's own `Vpc` class in imports. Proposal: `VpcNetwork` — explicit, no conflicts, follows G10 (Blocks-level abstraction over the AWS primitive).


---

## Appendix: Current Workaround (Escape Hatch)

A working VPC pattern is available today in [`apps/example-vpc/`](https://github.com/aws-devtools-labs/aws-blocks/tree/main/apps/example-vpc) without any framework changes. It uses CDK Mixins and utility functions to apply VPC placement post-hoc:

### How it works

1. **VPC created in a separate stack** — standard CDK `ec2.Vpc` with public/private/isolated subnets.
2. **`applyVpcToLambdas(blocksStack, vpc)`** — a helper that:
   - Creates a shared security group
   - Uses `Mixins.of(stack, ConstructSelector.resourcesOfType('AWS::Lambda::Function')).apply(...)` to patch ALL Lambda functions at the L1 (CfnFunction) level with VPC config
   - Grants `AWSLambdaVPCAccessExecutionRole` to every Lambda role
3. **`addBlocksEndpoints(vpc, ['Database', 'Logs', ...])`** — a helper mapping BB names to required VPC endpoints. Includes a `BLOCK_ENDPOINT_MAP` that documents which BBs need which endpoints (and which are covered by always-included free gateway endpoints).
4. **Separate database stack** — demonstrates the "platform-team-managed Aurora" pattern, with the Blocks app importing via `fromExisting()`.

### Key utilities (`vpc-utils.ts`)

- **`VpcPlacement` mixin** — CDK Mixin that patches `CfnFunction.vpcConfig` on any Lambda construct in the tree. Skips functions already configured (e.g., bb-data's migration Lambda).
- **`addBlocksEndpoints(vpc, blocks)`** — Always adds free gateway endpoints (DynamoDB, S3) + SSM interface endpoint. Adds additional interface endpoints (~$7/mo each) based on which BBs the customer declares. Deduplicates automatically.
- **`createBlocksWaf(scope, id, options)`** — WAF helper with rate limiting, AWS managed rules, and IP allowlisting.

### Limitations vs first-class support

| Aspect | Escape hatch (today) | First-class (proposed) |
|--------|---------------------|----------------------|
| VPC placement | Post-hoc L1 patching via Mixin | Native `vpc` prop on BlocksStack |
| Endpoint detection | Manual list: `['Database', 'Logs']` | Auto-detected from BB presence |
| Security group wiring | All Lambdas share one SG | Per-BB SG rules via `VpcContext` |
| bb-data integration | Separate stack + `fromExisting()` | Auto-uses shared VPC when present |
| Multi-compute awareness | N/A (single Lambda today) | Per-handler VPC opt-in (future) |

### Usage

```typescript
// index.cdk.ts (abbreviated)
import { applyVpcToLambdas, addBlocksEndpoints } from './vpc-utils.js';

const vpc = new ec2.Vpc(vpcStack, 'AppVpc', { maxAzs: 2, natGateways: 1, ... });

export const blocksStack = await BlocksStack.create(app, stackName, { ... });

addBlocksEndpoints(vpc, ['Database', 'DatabaseData', 'Logs']);
applyVpcToLambdas(blocksStack, vpc);
```

This pattern is suitable for production use today. The first-class feature would simplify this to `vpc: true` or `vpc: { size: 'default' }` on BlocksStack.

---

## Appendix: Test Infrastructure

### Persistent VPC stack

A shared test VPC stack deployed once per account/region. Not torn down between test runs.

```typescript
// test-infra/vpc-test-stack.ts (deployed independently, not per-test)
const vpc = new ec2.Vpc(this, 'BlocksTestVpc', {
  maxAzs: 2,
  natGateways: 1,
  subnetConfiguration: [
    { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
    { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  ],
});

// Pre-provision common endpoints so individual test deploys don't hit endpoint creation latency
vpc.addGatewayEndpoint('DynamoDb', { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });
vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });
vpc.addInterfaceEndpoint('Ssm', { service: ec2.InterfaceVpcEndpointAwsService.SSM });
vpc.addInterfaceEndpoint('SecretsManager', { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER });
vpc.addInterfaceEndpoint('Logs', { service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });

// Export VPC ID for test apps to reference
new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId, exportName: 'BlocksTestVpcId' });
```

### Test app usage

```typescript
// test-apps/vpc-smoke/aws-blocks/index.cdk.ts
const testVpc = ec2.Vpc.fromLookup(app, 'TestVpc', {
  vpcId: process.env.BLOCKS_TEST_VPC_ID || 'vpc-xxxxxx',
});

await BlocksStack.create(app, stackName, {
  ...,
  vpc: { existing: testVpc, skipEndpoints: true }, // endpoints already in the persistent VPC
});
```

### Why this works without cross-test contamination

- Each test run creates a unique stack name (via `getStackName({ sandbox: true, ... })`)
- BB resources get unique names from `fullId` (includes the stack's random suffix)
- Lambda functions, DynamoDB tables, etc. are all namespaced per deploy
- The VPC itself is shared infrastructure (subnets, endpoints) — not test-specific state
- Teardown removes all BB resources; the VPC stays

### Quota considerations

| Resource | Default quota | Our usage |
|----------|--------------|-----------|
| VPCs per region | 5 | 1 (persistent) |
| Subnets per VPC | 200 | 6 (2 AZ × 3 tiers) |
| Interface endpoints per VPC | 50 | ~5-8 |
| ENIs per region | 5,000 | ~2-4 per test deploy (Lambda) |
| NAT gateways per AZ | 5 | 1 |

The persistent VPC approach keeps us well within quotas even with parallel test runs.
