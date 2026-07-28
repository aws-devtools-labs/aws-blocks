// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { BlocksVpcOptions, VpcEndpointRegistration, VpcContext, VpcRequirements, SubnetRole } from './vpc-types.js';

const VPC_ENDPOINTS_KEY = Symbol.for('BLOCKS_VPC_ENDPOINTS');
const VPC_REQUIREMENTS_KEY = Symbol.for('BLOCKS_VPC_REQUIREMENTS');
const VPC_CONTEXT_KEY = Symbol.for('BLOCKS_VPC_CONTEXT');

/**
 * Register a VPC endpoint that this Building Block needs.
 * Called by BB CDK constructors with the actual CDK endpoint service object.
 * The collection/provisioning layer deduplicates by service name and provisions
 * the endpoint at finalization time.
 * @internal
 */
export function registerVpcEndpoint(scope: Construct, endpoint: VpcEndpointRegistration): void {
  const existing = (scope as any)[VPC_ENDPOINTS_KEY] as VpcEndpointRegistration[] | undefined;
  if (existing) {
    existing.push(endpoint);
  } else {
    (scope as any)[VPC_ENDPOINTS_KEY] = [endpoint];
  }
}

/**
 * Register VPC requirements (subnet role) for a Building Block.
 * Called by BB CDK constructors to declare what subnet role they need.
 * @internal
 */
export function registerVpcRequirements(scope: Construct, requirements: VpcRequirements): void {
  const existing = (scope as any)[VPC_REQUIREMENTS_KEY] as VpcRequirements | undefined;
  if (existing) {
    (scope as any)[VPC_REQUIREMENTS_KEY] = {
      subnetRole: requirements.subnetRole || existing.subnetRole,
    };
  } else {
    (scope as any)[VPC_REQUIREMENTS_KEY] = requirements;
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
 * Collect all VPC endpoint registrations from the construct tree rooted at `scope`.
 * Walks all children recursively.
 * @internal
 */
function collectVpcEndpoints(scope: Construct): VpcEndpointRegistration[] {
  const all: VpcEndpointRegistration[] = [];

  function walk(node: Construct) {
    const eps = (node as any)[VPC_ENDPOINTS_KEY] as VpcEndpointRegistration[] | undefined;
    if (eps) {
      all.push(...eps);
    }
    for (const child of node.node.children) {
      if ('node' in child) {
        walk(child as Construct);
      }
    }
  }

  walk(scope);
  return all;
}

/**
 * Get a unique string key for a service object to use for deduplication.
 */
function getServiceKey(endpoint: VpcEndpointRegistration): string {
  if (endpoint.type === 'gateway') {
    // GatewayVpcEndpointAwsService exposes a `.name` property
    return `gateway:${(endpoint.service as any).name ?? endpoint.service}`;
  }
  // InterfaceVpcEndpointAwsService exposes a `.name` property
  return `interface:${(endpoint.service as any).name ?? endpoint.service}`;
}

/**
 * Deduplicate endpoint registrations by service identity.
 * First registration wins.
 */
function deduplicateEndpoints(endpoints: VpcEndpointRegistration[]): VpcEndpointRegistration[] {
  const map = new Map<string, VpcEndpointRegistration>();
  for (const ep of endpoints) {
    const key = getServiceKey(ep);
    if (!map.has(key)) {
      map.set(key, ep);
    }
  }
  return Array.from(map.values());
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
  const { vpc, lambdaSubnets } = options;

  const resolvedSubnets = lambdaSubnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

  const lambdaSecurityGroup = new ec2.SecurityGroup(scope, 'BlocksLambdaSg', {
    vpc,
    description: 'Security group for Blocks Lambda functions in VPC',
    allowAllOutbound: true,
  });

  const context: VpcContext = {
    vpc,
    lambdaSecurityGroup,
    lambdaSubnets: resolvedSubnets,
    selectSubnets(role: SubnetRole): ec2.SubnetSelection {
      switch (role) {
        case 'isolated':
          return { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
        case 'public':
          return { subnetType: ec2.SubnetType.PUBLIC };
        case 'private-with-egress':
        default:
          return { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
      }
    },
  };

  setVpcContext(scope, context);
  return context;
}

/**
 * Finalize VPC: collect endpoint registrations from all BBs, deduplicate, and provision.
 * Called after all BBs are constructed (alongside finalizeConfigRegistry).
 * @internal
 */
export function finalizeVpc(scope: Construct, options: BlocksVpcOptions): void {
  const endpointsOption = options.endpoints ?? 'auto';

  if (endpointsOption === 'none') {
    return;
  }

  const { vpc } = options;

  // Collect from BB registrations
  const collected = collectVpcEndpoints(scope);
  // Always add CloudWatch Logs (Lambda needs it for log delivery from within VPC)
  collected.push({ type: 'interface', service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });
  // Always add SSM (auth BBs and AppSetting all use SSM)
  collected.push({ type: 'interface', service: ec2.InterfaceVpcEndpointAwsService.SSM });

  const endpoints = deduplicateEndpoints(collected);

  const provisionedKeys = new Set<string>();

  for (const ep of endpoints) {
    const key = getServiceKey(ep);
    if (provisionedKeys.has(key)) continue;
    provisionedKeys.add(key);

    // Create a construct ID from the service key
    const constructId = `VpcEp${key.replace(/[^a-zA-Z0-9]/g, '')}`;

    if (ep.type === 'gateway') {
      vpc.addGatewayEndpoint(constructId, {
        service: ep.service as ec2.GatewayVpcEndpointAwsService,
      });
    } else {
      vpc.addInterfaceEndpoint(constructId, {
        service: ep.service as ec2.InterfaceVpcEndpointAwsService,
        privateDnsEnabled: true,
      });
    }
  }
}
