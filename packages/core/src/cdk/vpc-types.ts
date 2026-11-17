// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { IConstruct } from 'constructs';

/**
 * A subnet role — the kind of subnet a Building Block needs, expressed as an
 * intent the VPC resolves to a concrete {@link ec2.SubnetSelection}:
 *
 * - `'private-with-egress'` — private subnets with outbound internet access via
 *   a NAT gateway. Required by anything that must reach a public AWS endpoint at
 *   runtime (e.g. a service with no interface endpoint).
 * - `'isolated'` — private subnets with no internet route at all. Best for
 *   resources reached entirely over VPC endpoints or in-VPC (e.g. a database).
 * - `'public'` — subnets with a direct internet gateway route.
 */
export type SubnetRole = 'private-with-egress' | 'isolated' | 'public';

/**
 * Options for VPC integration on BlocksStack / BlocksBackend.
 *
 * @example
 * ```ts
 * const vpc = new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 });
 * await BlocksStack.create(app, stackName, {
 *   backendHandlerPath: join(__dirname, 'index.handler.ts'),
 *   backendCDKPath: join(__dirname, 'index.ts'),
 *   defaults: { ...BlocksPresets.production, vpc: { network: vpc } },
 * });
 * ```
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
	network: ec2.IVpc;

	/**
	 * Subnet selection for Lambda and Blocks-managed compute placement.
	 *
	 * Any subnets you select must belong to {@link network}. This is not
	 * validated at synth — CDK can't check it for an imported subnet (which
	 * carries no `vpcId`) — so a mismatch surfaces as a CloudFormation error at
	 * deploy, not a synth-time failure.
	 *
	 * @default { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
	 */
	subnets?: ec2.SubnetSelection;

	/**
	 * Whether to auto-provision VPC endpoints based on BB registrations.
	 * Set to `false` to disable (e.g., when using a shared VPC that already has endpoints).
	 *
	 * @default true
	 */
	provisionEndpoints?: boolean;
}

/**
 * VPC requirements declared by a Building Block.
 * Supplied to the `BuildingBlockScope` constructor and collected in the central
 * requirements registry; `finalizeVpc` pulls them to provision endpoints and wire
 * their security group, and the lazy VPC uses `requiresVpc` to decide whether to
 * derive a VPC when none was provided.
 */
export interface VpcRequirements {
	/** Gateway VPC endpoints this BB needs (e.g., S3, DynamoDB). */
	gatewayEndpoints?: ec2.GatewayVpcEndpointAwsService[];
	/** Interface VPC endpoints this BB needs (e.g., SQS, SSM, Secrets Manager). */
	interfaceEndpoints?: ec2.InterfaceVpcEndpointAwsService[];
	/**
	 * Whether this BB **cannot function without a VPC** — i.e. it must run in (or
	 * provision resources into) a VPC regardless of whether the customer asked
	 * for one. When any registered requirement sets this and no `vpc` was
	 * provided, the framework **lazily derives** a default VPC (see
	 * `getOrCreateVpc`) rather than erroring — mirroring how bb-data creates its
	 * own VPC when no shared one exists.
	 *
	 * Most BBs leave this unset: they reach AWS services from the AWS-managed
	 * Lambda network and only *benefit* from a VPC (endpoints) when one is present.
	 * Set it only for a BB whose resources are intrinsically VPC-resident.
	 *
	 * @default false
	 */
	requiresVpc?: boolean;
	/**
	 * Whether the BB's **parent runtime** — the shared Blocks handler Lambda (or,
	 * in future, a container) that executes this BB's operations — must be able to
	 * reach the internet (outbound egress) for the BB to work at runtime.
	 *
	 * Set this when your BB's runtime code calls a service it can only reach over
	 * the public internet. The canonical case: a service with no VPC endpoint
	 * (e.g. Aurora DSQL) is reached over a public HTTPS endpoint, so the runtime
	 * must sit in a subnet with an egress route; if it's placed in isolated
	 * subnets the deploy still succeeds but every call times out at runtime.
	 *
	 * The framework **validates** this at synth against the runtime's resolved
	 * placement (egress is satisfied by a `private-with-egress` or `public`
	 * selection) and fails the build with an actionable message on a mismatch. It
	 * never moves the runtime — reassigning a customer's explicit placement is not
	 * a BB's responsibility, so an unsatisfiable requirement is an error, not a
	 * silent relocation.
	 *
	 * This constrains the BB's **host**. To place compute the BB provisions
	 * **itself** (e.g. an Aurora cluster), resolve a subnet inline in your
	 * constructor via {@link VpcContext.selectSubnets} instead.
	 *
	 * @default false
	 */
	requiresEgress?: boolean;
	/**
	 * Security groups of compute the BB provisions **itself** (not the shared
	 * Blocks runtime) that must reach the Blocks-managed interface endpoints —
	 * e.g. the rotation Lambda a `Database` places in the shared VPC. The endpoint
	 * security group admits only the Blocks Lambda SG by default (see
	 * `finalizeVpc`), so without this registration such compute cannot reach the
	 * endpoints and fails at runtime. Each listed security group gets a 443
	 * ingress rule on the endpoint security group; when `provisionEndpoints` is
	 * `false` the framework instead warns, naming the security group the customer
	 * must admit on their own endpoints.
	 *
	 * A group the BB **creates itself** cannot be declared in the
	 * `BuildingBlockScope` constructor call: that registration runs before the
	 * BB has built anything, so the group does not exist yet. Declare it in a
	 * second `registerVpcRequirements(this, { endpointClientSecurityGroups: [sg]
	 * })` call once it does, importing that function from
	 * `@aws-blocks/core/cdk/internal` — the framework-internal entry point,
	 * which carries no backward-compatibility guarantee, unlike this type.
	 * Registrations accumulate, so the second call adds to the first. A group
	 * the BB is handed or imports needs no second call: pass it in the
	 * constructor like any other requirement.
	 */
	endpointClientSecurityGroups?: ec2.ISecurityGroup[];

	/**
	 * Constructs of the BB that must not be created before its registered
	 * `endpointClientSecurityGroups` can reach the endpoints — e.g. a
	 * `Database`'s rotation schedule, which rotates as soon as it exists and has
	 * no route until the endpoint and the ingress rule admitting the rotation
	 * Lambda are in place. `finalizeVpc` orders each one after the endpoints and
	 * that rule.
	 *
	 * Register the construct itself only if nothing the endpoint security group
	 * references depends on it; a whole BB would cycle, because the endpoint
	 * security group references the BB's own client security group.
	 *
	 * Declared the same way, and for the same reason, as
	 * {@link VpcRequirements.endpointClientSecurityGroups}: a construct the BB
	 * creates itself goes in a second `registerVpcRequirements` call from
	 * `@aws-blocks/core/cdk/internal`.
	 */
	endpointClientDependents?: IConstruct[];
}

/**
 * The minimal shape {@link VpcContext.selectSubnets} needs from a Building
 * Block to produce an instructive, BB-named error — just its `fullId`. Typed
 * structurally so `vpc-types.ts` stays type-only and free of a dependency on
 * the `Scope` class.
 */
export interface SubnetScope {
	readonly fullId: string;
}

/**
 * Internal VPC context propagated through the construct tree.
 * Set by the CDK-level VPC option. BBs read this to determine their VPC placement.
 * @internal
 */
export interface VpcContext {
	readonly vpc: ec2.IVpc;
	readonly computeSecurityGroup: ec2.ISecurityGroup;
	readonly computeSubnets: ec2.SubnetSelection;
	/**
	 * Where this shared VPC came from:
	 *
	 * - `'provided'` — the customer passed it via `defaults.vpc.network`. An
	 *   explicit choice, so **stateful** Building Blocks (e.g. `Database`) place
	 *   their resources in it, exactly as before.
	 * - `'derived'` — Blocks created it automatically because some block required
	 *   a VPC (today: a container compute). Stateless compute (Lambda, the
	 *   container) shares it, but a stateful block must **not** auto-join a derived
	 *   VPC: doing so would move an existing cluster into a new VPC on a routine
	 *   change (e.g. adding a container), replacing it and destroying its data.
	 *   Such a block keeps provisioning its own VPC instead.
	 *
	 * The distinction exists only because a derived shared VPC is new: before it,
	 * the only shared VPC was a customer-provided one, which a stateful block
	 * could always safely join.
	 */
	readonly source: 'provided' | 'derived';
	/**
	 * Resolve a {@link SubnetRole} to a concrete {@link ec2.SubnetSelection} for a
	 * resource this Building Block provisions itself, verifying the VPC actually
	 * has subnets of that role.
	 *
	 * Prefer this over building an `ec2.SubnetSelection` by hand: if the VPC has
	 * no matching subnet, it throws an actionable, BB-named error at synth
	 * ("`KVStore 'app/cache'` needs an 'isolated' subnet, but VPC 'vpc-…' has
	 * none …") instead of the opaque CDK "no subnet groups" error thrown later.
	 *
	 * @param scope   the BB requesting the subnet (its `fullId` names the error)
	 * @param role    the subnet role the BB's own resource needs
	 * @param opts.fallback  an alternate role to use when `role` is absent from
	 *   the VPC. Provide it to **explicitly** allow graceful degradation (e.g.
	 *   Aurora over the Data API works from `'private-with-egress'` when there is
	 *   no isolated tier); omit it to require `role` strictly and fail otherwise.
	 *   The downgrade is never silent — it only happens when you opt in here.
	 * @throws if the VPC has neither `role` nor (when given) `opts.fallback`
	 */
	selectSubnets(scope: SubnetScope, role: SubnetRole, opts?: { fallback?: SubnetRole }): ec2.SubnetSelection;
}
