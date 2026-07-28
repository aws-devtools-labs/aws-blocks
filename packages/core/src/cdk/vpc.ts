// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { BlocksVpcOptions, VpcEndpointRequirement, VpcContext, SubnetRole } from './vpc-types.js';

const VPC_REQUIREMENTS_KEY = Symbol.for('BLOCKS_VPC_REQUIREMENTS');
const VPC_CONTEXT_KEY = Symbol.for('BLOCKS_VPC_CONTEXT');

/**
 * Register VPC requirements for a Building Block.
 * Called by BB CDK constructors to declare what endpoints they need.
 * Requirements are collected at finalization time.
 * @internal
 */
export function registerVpcRequirements(scope: Construct, requirements: { endpoints?: VpcEndpointRequirement[]; subnetRole?: SubnetRole }): void {
  const existing = (scope as any)[VPC_REQUIREMENTS_KEY] as { endpoints?: VpcEndpointRequirement[]; subnetRole?: SubnetRole } | undefined;
  if (existing) {
    // Merge: append endpoints
    const merged = {
      endpoints: [...(existing.endpoints || []), ...(requirements.endpoints || [])],
      subnetRole: requirements.subnetRole || existing.subnetRole,
    };
    (scope as any)[VPC_REQUIREMENTS_KEY] = merged;
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
 * Collect all VPC requirements from the construct tree rooted at `scope`.
 * Walks all children recursively and collects their registered requirements.
 * @internal
 */
function collectVpcRequirements(scope: Construct): VpcEndpointRequirement[] {
  const all: VpcEndpointRequirement[] = [];

  function walk(node: Construct) {
    const reqs = (node as any)[VPC_REQUIREMENTS_KEY] as { endpoints?: VpcEndpointRequirement[] } | undefined;
    if (reqs?.endpoints) {
      all.push(...reqs.endpoints);
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
 * Deduplicate endpoint requirements by service name.
 * Prefers 'gateway' type if both are declared (gateway is free).
 */
function deduplicateEndpoints(endpoints: VpcEndpointRequirement[]): VpcEndpointRequirement[] {
  const map = new Map<string, VpcEndpointRequirement>();
  for (const ep of endpoints) {
    const existing = map.get(ep.service);
    if (!existing) {
      map.set(ep.service, ep);
    }
    // If already exists, keep the existing (first declared wins; gateway preferred)
  }
  return Array.from(map.values());
}

/**
 * Map a service short name to an InterfaceVpcEndpointAwsService.
 */
function getInterfaceService(service: string): ec2.InterfaceVpcEndpointAwsService {
  const serviceMap: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
    'secretsmanager': ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    'rds-data': ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
    'ssm': ec2.InterfaceVpcEndpointAwsService.SSM,
    'sqs': ec2.InterfaceVpcEndpointAwsService.SQS,
    'ses': ec2.InterfaceVpcEndpointAwsService.SES,
    'bedrock-runtime': ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
    'logs': ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    'execute-api': ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
  };
  const resolved = serviceMap[service];
  if (!resolved) {
    // Fallback: construct from service name
    return new ec2.InterfaceVpcEndpointAwsService(`com.amazonaws.${service}`);
  }
  return resolved;
}

/**
 * Map a service short name to a GatewayVpcEndpointAwsService.
 */
function getGatewayService(service: string): ec2.GatewayVpcEndpointAwsService {
  const serviceMap: Record<string, ec2.GatewayVpcEndpointAwsService> = {
    'dynamodb': ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    's3': ec2.GatewayVpcEndpointAwsService.S3,
  };
  const resolved = serviceMap[service];
  if (!resolved) {
    throw new Error(`Unknown gateway VPC endpoint service: ${service}. Only 'dynamodb' and 's3' are supported as gateway endpoints.`);
  }
  return resolved;
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
 * Finalize VPC: collect requirements from all BBs, deduplicate, and provision endpoints.
 * Called after all BBs are constructed (alongside finalizeConfigRegistry).
 * @internal
 */
export function finalizeVpc(scope: Construct, options: BlocksVpcOptions): void {
  const endpointsOption = options.endpoints ?? 'auto';

  if (endpointsOption === 'none') {
    return;
  }

  const { vpc } = options;
  let endpoints: VpcEndpointRequirement[];

  if (endpointsOption === 'auto') {
    // Collect from BB registrations
    const collected = collectVpcRequirements(scope);
    // Always add CloudWatch Logs (Lambda needs it for log delivery from within VPC)
    collected.push({ service: 'logs', type: 'interface' });
    // Always add SSM (auth BBs and AppSetting all use SSM)
    collected.push({ service: 'ssm', type: 'interface' });
    endpoints = deduplicateEndpoints(collected);
  } else {
    // Explicit list from customer
    endpoints = endpointsOption.map(ep => ({
      service: ep.service,
      type: ep.type ?? 'interface',
    }));
  }

  const provisionedEndpoints = new Set<string>();

  for (const ep of endpoints) {
    if (provisionedEndpoints.has(ep.service)) continue;
    provisionedEndpoints.add(ep.service);

    // Create a construct ID from the service name
    const constructId = `VpcEp${ep.service.replace(/[^a-zA-Z0-9]/g, '')}`;

    if (ep.type === 'gateway') {
      vpc.addGatewayEndpoint(constructId, {
        service: getGatewayService(ep.service),
      });
    } else {
      vpc.addInterfaceEndpoint(constructId, {
        service: getInterfaceService(ep.service),
        privateDnsEnabled: true,
      });
    }
  }
}
