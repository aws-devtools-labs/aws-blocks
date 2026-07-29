// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { BlocksVpcOptions, VpcContext, VpcRequirements, SubnetRole } from './vpc-types.js';

const VPC_GATEWAY_ENDPOINTS_KEY = Symbol.for('BLOCKS_VPC_GATEWAY_ENDPOINTS');
const VPC_INTERFACE_ENDPOINTS_KEY = Symbol.for('BLOCKS_VPC_INTERFACE_ENDPOINTS');
const VPC_REQUIREMENTS_KEY = Symbol.for('BLOCKS_VPC_REQUIREMENTS');
const VPC_CONTEXT_KEY = Symbol.for('BLOCKS_VPC_CONTEXT');

/**
 * Register a gateway VPC endpoint requirement for a Building Block.
 * Called by BB CDK constructors to declare what gateway endpoints they need.
 * @internal
 */
export function registerVpcGatewayEndpoint(scope: Construct, service: ec2.GatewayVpcEndpointAwsService): void {
  const existing = (scope as any)[VPC_GATEWAY_ENDPOINTS_KEY] as ec2.GatewayVpcEndpointAwsService[] | undefined;
  if (existing) {
    existing.push(service);
  } else {
    (scope as any)[VPC_GATEWAY_ENDPOINTS_KEY] = [service];
  }
}

/**
 * Register an interface VPC endpoint requirement for a Building Block.
 * Called by BB CDK constructors to declare what interface endpoints they need.
 * @internal
 */
export function registerVpcInterfaceEndpoint(scope: Construct, service: ec2.InterfaceVpcEndpointAwsService): void {
  const existing = (scope as any)[VPC_INTERFACE_ENDPOINTS_KEY] as ec2.InterfaceVpcEndpointAwsService[] | undefined;
  if (existing) {
    existing.push(service);
  } else {
    (scope as any)[VPC_INTERFACE_ENDPOINTS_KEY] = [service];
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
 * Collect all gateway endpoint registrations from the construct tree.
 * @internal
 */
function collectGatewayEndpoints(scope: Construct): ec2.GatewayVpcEndpointAwsService[] {
  const all: ec2.GatewayVpcEndpointAwsService[] = [];

  function walk(node: Construct) {
    const eps = (node as any)[VPC_GATEWAY_ENDPOINTS_KEY] as ec2.GatewayVpcEndpointAwsService[] | undefined;
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
 * Collect all interface endpoint registrations from the construct tree.
 * @internal
 */
function collectInterfaceEndpoints(scope: Construct): ec2.InterfaceVpcEndpointAwsService[] {
  const all: ec2.InterfaceVpcEndpointAwsService[] = [];

  function walk(node: Construct) {
    const eps = (node as any)[VPC_INTERFACE_ENDPOINTS_KEY] as ec2.InterfaceVpcEndpointAwsService[] | undefined;
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
 * Initialize VPC support on a Blocks scope (BlocksStack or BlocksBackend).
 * Creates the security group, sets VPC context, and returns the VpcContext
 * that is used for Lambda placement configuration.
 *
 * Called during setupBlocksInfra when `vpc` prop is present.
 * @internal
 */
export function initializeVpc(scope: Construct, options: BlocksVpcOptions): VpcContext {
  const { vpc, subnets } = options;

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
  if (options.provisionEndpoints === false) {
    return;
  }

  const { vpc } = options;

  // Collect gateway endpoints from BB registrations and deduplicate
  const gatewayEndpoints = collectGatewayEndpoints(scope);
  const provisionedGateway = new Set<string>();

  for (const service of gatewayEndpoints) {
    const key = (service as any).name ?? String(service);
    if (provisionedGateway.has(key)) continue;
    provisionedGateway.add(key);

    const constructId = `VpcGw${key.replace(/[^a-zA-Z0-9]/g, '')}`;
    new ec2.GatewayVpcEndpoint(scope, constructId, { vpc, service });
  }

  // Collect interface endpoints from BB registrations and deduplicate
  const interfaceEndpoints = collectInterfaceEndpoints(scope);
  // Always add CloudWatch Logs (Lambda needs it for log delivery from within VPC)
  interfaceEndpoints.push(ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
  // Always add SSM (auth BBs and AppSetting all use SSM)
  interfaceEndpoints.push(ec2.InterfaceVpcEndpointAwsService.SSM);

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
    });
  }
}
