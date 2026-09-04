// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Annotations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { BlocksVpcOptions, SubnetRole, SubnetScope, VpcContext, VpcRequirements } from './vpc-types.js';

const VPC_CONTEXT_KEY = Symbol.for('BLOCKS_VPC_CONTEXT');

/** Map a subnet role to its concrete CDK subnet type. */
function subnetTypeForRole(role: SubnetRole): ec2.SubnetType {
	switch (role) {
		case 'isolated':
			return ec2.SubnetType.PRIVATE_ISOLATED;
		case 'public':
			return ec2.SubnetType.PUBLIC;
		case 'private-with-egress':
			return ec2.SubnetType.PRIVATE_WITH_EGRESS;
	}
}

/** Does the VPC actually contain at least one subnet of the given role? */
function vpcHasRole(vpc: ec2.IVpc, role: SubnetRole): boolean {
	switch (role) {
		case 'isolated':
			return vpc.isolatedSubnets.length > 0;
		case 'public':
			return vpc.publicSubnets.length > 0;
		case 'private-with-egress':
			return vpc.privateSubnets.length > 0;
	}
}

/**
 * Set the VPC context on a scope (BlocksStack or BlocksBackend).
 * Called during stack creation when `vpc` prop is provided.
 * @internal
 */
export function setVpcContext(scope: Construct, context: VpcContext): void {
	(scope as any)[VPC_CONTEXT_KEY] = context;
}

/**
 * Get the VPC context from a scope by walking up the construct tree.
 * Used by BBs (e.g., bb-data) to discover the shared VPC.
 * @internal
 */
export function getVpcContext(scope: Construct): VpcContext | undefined {
	let current: Construct | undefined = scope;
	while (current) {
		const ctx = (current as any)[VPC_CONTEXT_KEY] as VpcContext | undefined;
		if (ctx) return ctx;
		current = current.node.scope as Construct | undefined;
	}
	return undefined;
}

/**
 * Type guard: does this construct implement the BuildingBlockScope protocol
 * (i.e., has a getVpcRequirements method)?
 */
function hasBuildingBlockProtocol(
	construct: Construct,
): construct is Construct & { getVpcRequirements(): VpcRequirements } {
	return typeof (construct as any).getVpcRequirements === 'function';
}

/**
 * Initialize VPC support on a Blocks scope (BlocksStack or BlocksBackend).
 * Creates the security group, sets VPC context, and returns the VpcContext
 * that is used for Lambda placement configuration.
 *
 * Called during setupBlocksInfra when `vpc` prop is present.
 * @internal
 */
export function initializeVpc(scope: Construct, options: BlocksVpcOptions): VpcContext {
	const { network: vpc, subnets } = options;

	// Default Lambda placement to private-with-egress. Guard the default: if the
	// caller didn't specify `subnets` and the VPC has no such tier, fail now with
	// an actionable message instead of letting Lambda placement throw a cryptic
	// CDK error later. (A caller who *explicitly* passes an isolated selection is
	// honored — per-BB `requiresEgress` validation catches BBs that can't run there.)
	if (!subnets && !vpcHasRole(vpc, 'private-with-egress')) {
		throw new Error(
			`VPC '${vpc.vpcId}' has no private-with-egress subnets, which Blocks uses for Lambda ` +
				`placement by default. Add a PRIVATE_WITH_EGRESS subnet tier (a private subnet with a ` +
				`NAT gateway), or pass 'vpc.subnets' to choose a different placement explicitly. ` +
				`See packages/blocks/VPC.md.`,
		);
	}

	const resolvedSubnets = subnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

	const lambdaSecurityGroup = new ec2.SecurityGroup(scope, 'BlocksLambdaSg', {
		vpc,
		description: 'Security group for Blocks Lambda functions in VPC',
		allowAllOutbound: true,
	});

	const context: VpcContext = {
		vpc,
		lambdaSecurityGroup,
		lambdaSubnets: resolvedSubnets,
		selectSubnets(scope: SubnetScope, role: SubnetRole, opts?: { fallback?: SubnetRole }): ec2.SubnetSelection {
			if (vpcHasRole(vpc, role)) {
				return { subnetType: subnetTypeForRole(role) };
			}
			// Requested role is absent. Fall back only if the BB explicitly opted in
			// AND the fallback role actually exists — never downgrade silently.
			if (opts?.fallback && vpcHasRole(vpc, opts.fallback)) {
				return { subnetType: subnetTypeForRole(opts.fallback) };
			}
			const wanted = opts?.fallback ? `'${role}' (or '${opts.fallback}')` : `'${role}'`;
			throw new Error(
				`${scope.fullId} needs a ${wanted} subnet, but VPC '${vpc.vpcId}' has none. ` +
					`Add a matching subnet tier to your VPC (e.g. a 'subnetConfiguration' entry of the ` +
					`required type), or place the Building Block differently. ` +
					`See packages/blocks/VPC.md for guidance.`,
			);
		},
	};

	setVpcContext(scope, context);
	return context;
}

/**
 * Finalize VPC: query all BuildingBlockScope children for their VPC requirements,
 * deduplicate, and provision endpoints.
 * Called after all BBs are constructed (alongside finalizeConfigRegistry).
 * @internal
 */
export function finalizeVpc(scope: Construct, options: BlocksVpcOptions): void {
	const { network: vpc, subnets } = options;

	// Whether the runtime's placement provides egress (outbound internet). This is
	// the only capability the requirement check needs — a BB either needs egress
	// or it doesn't. Resolved from the actual selected subnets rather than guessed
	// from a subnet role, so an explicit subnet *list* (no subnetType) is handled
	// correctly. `undefined` = couldn't determine (e.g. an imported VPC whose
	// subnets aren't known at synth) → we skip validation with a warning rather
	// than fabricate an answer.
	const placementHasEgress: boolean | undefined = placementProvidesEgress(vpc, subnets);

	const gatewayEndpoints: ec2.GatewayVpcEndpointAwsService[] = [];
	const interfaceEndpoints: ec2.InterfaceVpcEndpointAwsService[] = [];

	// Pull requirements from all BuildingBlockScope instances in the tree.
	for (const child of scope.node.findAll()) {
		if (hasBuildingBlockProtocol(child)) {
			const reqs = child.getVpcRequirements();
			if (reqs.gatewayEndpoints) {
				gatewayEndpoints.push(...reqs.gatewayEndpoints);
			}
			if (reqs.interfaceEndpoints) {
				interfaceEndpoints.push(...reqs.interfaceEndpoints);
			}
			// Validate the BB's runtime egress need against where the runtime is
			// actually placed. We never move the runtime (that's the customer's
			// explicit choice) — an unsatisfiable requirement is a synth error, not a
			// silent relocation. This turns an otherwise-silent runtime failure (e.g.
			// DSQL in an isolated Lambda: deploys clean, times out on every call) into
			// an actionable build error.
			if (reqs.requiresEgress) {
				const fullId = (child as { fullId?: string }).fullId ?? child.node.id;
				if (placementHasEgress === false) {
					throw new Error(
						`${fullId} requires its runtime to reach the internet (outbound egress), but the ` +
							`Blocks runtime is placed in subnets with no egress route. ` +
							`Set 'vpc.subnets' to a 'private-with-egress' (or 'public') selection, or remove ` +
							`the Building Block that needs it. See packages/blocks/VPC.md.`,
					);
				}
				if (placementHasEgress === undefined) {
					// Couldn't determine egress (e.g. imported VPC with unknown subnets).
					// Don't fabricate a pass/fail — warn so a real mismatch isn't silent.
					Annotations.of(scope).addWarningV2(
						'blocks:vpc:egress-unverified',
						`${fullId} requires runtime egress, but Blocks couldn't determine whether the ` +
							`configured subnets provide it (e.g. an imported VPC). Ensure the runtime's subnets ` +
							`have an outbound internet route. See packages/blocks/VPC.md.`,
					);
				}
			}
		}
	}

	if (options.provisionEndpoints === false) {
		return;
	}

	// Always add the S3 gateway endpoint. The runtime pulls config/secrets and
	// migrations from S3 at cold start, so an in-VPC runtime needs it. Gateway
	// endpoints are free (route-table entries, no ENI), so this is unconditional.
	gatewayEndpoints.push(ec2.GatewayVpcEndpointAwsService.S3);

	// Provision gateway endpoints (deduplicated). Gateway endpoints attach to
	// route tables, not ENIs, so they have no security-group layer.
	const provisionedGateway = new Set<string>();

	for (const service of gatewayEndpoints) {
		const key = service.name;
		if (provisionedGateway.has(key)) continue;
		provisionedGateway.add(key);

		const constructId = `VpcGw${key.replace(/[^a-zA-Z0-9]/g, '')}`;
		new ec2.GatewayVpcEndpoint(scope, constructId, { vpc, service });
	}

	// Always add CloudWatch Logs — every in-VPC Lambda needs it for log delivery,
	// regardless of which Building Blocks are present. SSM is NOT added here: it
	// flows from BB requirements (AppSetting and the auth blocks, which compose
	// AppSetting, declare it), so an app that uses neither doesn't pay for an
	// unused interface endpoint.
	interfaceEndpoints.push(ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);

	// Dedicated security group for the interface endpoints. Without an explicit
	// SG, CDK creates a default that allows 443 from the entire VPC CIDR — on a
	// bring-your-own VPC that exposes every endpoint to unrelated workloads. Scope
	// ingress to just the Blocks Lambda SG so only our functions can reach them.
	const ctx = getVpcContext(scope);
	const endpointSecurityGroup = new ec2.SecurityGroup(scope, 'BlocksVpcEndpointSg', {
		vpc,
		description: 'Blocks interface VPC endpoints — 443 from the Blocks Lambda only',
		allowAllOutbound: true,
	});
	if (ctx) {
		endpointSecurityGroup.addIngressRule(
			ec2.Peer.securityGroupId(ctx.lambdaSecurityGroup.securityGroupId),
			ec2.Port.tcp(443),
			'HTTPS from Blocks Lambda',
		);
	}

	// Provision interface endpoints (deduplicated)
	const provisionedInterface = new Set<string>();

	for (const service of interfaceEndpoints) {
		const key = service.name;
		if (provisionedInterface.has(key)) continue;
		provisionedInterface.add(key);

		const constructId = `VpcIf${key.replace(/[^a-zA-Z0-9]/g, '')}`;
		new ec2.InterfaceVpcEndpoint(scope, constructId, {
			vpc,
			service,
			privateDnsEnabled: true,
			securityGroups: [endpointSecurityGroup],
			// `open: false` suppresses CDK's default "allow 443 from the whole VPC
			// CIDR" ingress rule. Our dedicated SG already allows 443 from just the
			// Blocks Lambda SG; without this, CDK would re-widen access to the entire
			// VPC — the exact broadening this dedicated SG exists to prevent.
			open: false,
		});
	}
}

/**
 * Does the runtime's subnet placement provide egress (an outbound internet
 * route)? Returns `true`/`false` when determinable, or `undefined` when it
 * can't be determined at synth (e.g. an imported VPC whose subnets aren't
 * known) — callers should warn rather than assume.
 *
 * Resolved from the actual subnets, not from a subnet *role*, so an explicit
 * subnet **list** (which carries no `subnetType`) is handled correctly. For a
 * multi-subnet selection, egress is only reported when **every** selected
 * subnet has it (a runtime may land in any of them).
 */
function placementProvidesEgress(vpc: ec2.IVpc, selection?: ec2.SubnetSelection): boolean | undefined {
	// Default placement (no selection) is PRIVATE_WITH_EGRESS — see initializeVpc.
	if (!selection) {
		return vpc.privateSubnets.length > 0 ? true : undefined;
	}
	// Explicit type: egress iff it's the egress tier; isolated/public are known.
	if (selection.subnetType !== undefined) {
		switch (selection.subnetType) {
			case ec2.SubnetType.PRIVATE_WITH_EGRESS:
				return true;
			case ec2.SubnetType.PUBLIC:
				return true; // public subnets route to an internet gateway
			case ec2.SubnetType.PRIVATE_ISOLATED:
				return false;
			default:
				return undefined;
		}
	}
	// Explicit subnet list (or filter): resolve the concrete subnets and check
	// that all of them are egress-capable. If resolution yields nothing usable,
	// we can't tell.
	try {
		const { subnets: selected } = vpc.selectSubnets(selection);
		if (selected.length === 0) return undefined;
		// A subnet is egress-capable if it's one of the VPC's private (with-egress)
		// or public subnets. Isolated subnets are in neither list.
		const egressCapable = new Set<string>([
			...vpc.privateSubnets.map((s) => s.subnetId),
			...vpc.publicSubnets.map((s) => s.subnetId),
		]);
		// If the VPC exposes no subnet inventory (imported VPC), we can't classify.
		if (egressCapable.size === 0 && vpc.isolatedSubnets.length === 0) return undefined;
		return selected.every((s) => egressCapable.has(s.subnetId));
	} catch {
		return undefined;
	}
}
