// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { BlocksVpcOptions, VpcContext, VpcRequirements, SubnetRole } from './vpc-types.js';

const VPC_CONTEXT_KEY = Symbol.for('BLOCKS_VPC_CONTEXT');

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
function hasBuildingBlockProtocol(construct: Construct): construct is Construct & { getVpcRequirements(): VpcRequirements } {
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
 * Finalize VPC: query all BuildingBlockScope children for their VPC requirements,
 * deduplicate, and provision endpoints.
 * Called after all BBs are constructed (alongside finalizeConfigRegistry).
 * @internal
 */
export function finalizeVpc(scope: Construct, options: BlocksVpcOptions): void {
  if (options.provisionEndpoints === false) {
    return;
  }

  const { network: vpc } = options;

  const gatewayEndpoints: ec2.GatewayVpcEndpointAwsService[] = [];
  const interfaceEndpoints: ec2.InterfaceVpcEndpointAwsService[] = [];

  // Pull requirements from all BuildingBlockScope instances in the tree
  for (const child of scope.node.findAll()) {
    if (hasBuildingBlockProtocol(child)) {
      const reqs = child.getVpcRequirements();
      if (reqs.gatewayEndpoints) {
        gatewayEndpoints.push(...reqs.gatewayEndpoints);
      }
      if (reqs.interfaceEndpoints) {
        interfaceEndpoints.push(...reqs.interfaceEndpoints);
      }
    }
  }

  // Provision gateway endpoints (deduplicated)
  const provisionedGateway = new Set<string>();

  for (const service of gatewayEndpoints) {
    const key = (service as any).name ?? String(service);
    if (provisionedGateway.has(key)) continue;
    provisionedGateway.add(key);

    const constructId = `VpcGw${key.replace(/[^a-zA-Z0-9]/g, '')}`;
    new ec2.GatewayVpcEndpoint(scope, constructId, { vpc, service });
  }

  // Always add CloudWatch Logs (Lambda needs it for log delivery from within VPC)
  interfaceEndpoints.push(ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS);
  // Always add SSM (auth BBs and AppSetting all use SSM)
  interfaceEndpoints.push(ec2.InterfaceVpcEndpointAwsService.SSM);

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
    });
  }
}
