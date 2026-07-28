// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * Subnet role — BBs declare what kind of subnet they need.
 * The VPC maps roles to actual subnet selections.
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
 *   vpc: { vpc },
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
  vpc: ec2.IVpc;

  /**
   * Subnet selection for Lambda placement.
   * @default { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
   */
  lambdaSubnets?: ec2.SubnetSelection;

  /**
   * VPC endpoints to provision. When set to 'auto' (the default), endpoints
   * are determined by the BBs in scope — each BB registers actual CDK endpoint
   * service objects via `registerVpcEndpoint()`, and the framework deduplicates
   * and provisions them automatically. Set to 'none' to disable (e.g., when
   * using a shared VPC that already has endpoints).
   *
   * @default 'auto'
   */
  endpoints?: 'auto' | 'none';
}

/**
 * VPC requirements declared by a Building Block.
 * Collected during finalization to provision endpoints.
 */
export interface VpcRequirements {
  /** Subnet role for VPC-resident resources (e.g., Aurora needs 'isolated'). */
  subnetRole?: SubnetRole;
}

/**
 * A registered VPC endpoint — stores the actual CDK service object.
 * The BB owns the knowledge of what service it needs.
 */
export type VpcEndpointRegistration =
  | { type: 'gateway'; service: ec2.GatewayVpcEndpointAwsService }
  | { type: 'interface'; service: ec2.InterfaceVpcEndpointAwsService };

/**
 * Internal VPC context propagated through the construct tree.
 * Set by the CDK-level VPC option. BBs read this to determine their VPC placement.
 * @internal
 */
export interface VpcContext {
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  readonly lambdaSubnets: ec2.SubnetSelection;
  selectSubnets(role: SubnetRole): ec2.SubnetSelection;
}
