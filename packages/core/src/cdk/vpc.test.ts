// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import { finalizeVpc, getVpcContext, setVpcContext } from './vpc.js';
import type { BlocksVpcOptions, VpcRequirements } from './vpc-types.js';

// A minimal stand-in for a BuildingBlockScope: finalizeVpc only depends on the
// duck-typed protocol (a `getVpcRequirements()` method), so a bare Construct
// that implements it exercises the real pull-and-provision path without pulling
// every BB package into core's test graph.
class FakeBB extends Construct {
  constructor(
    scope: Construct,
    id: string,
    private readonly reqs: VpcRequirements,
  ) {
    super(scope, id);
  }
  getVpcRequirements(): VpcRequirements {
    return this.reqs;
  }
}

/** Build a stack with a VPC and the given fake BBs, then run finalizeVpc. */
function synthWith(bbs: (scope: Construct) => void, opts?: Partial<BlocksVpcOptions>): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 1 });
  bbs(stack);
  finalizeVpc(stack, { network: vpc, ...opts });
  return Template.fromStack(stack);
}

const IFACE = 'AWS::EC2::VPCEndpoint';

/** Count interface vs gateway endpoints in a synthesized template. */
function endpointCounts(template: Template): { iface: number; gateway: number } {
  const eps = template.findResources(IFACE);
  let iface = 0;
  let gateway = 0;
  for (const ep of Object.values(eps)) {
    const type = (ep as { Properties?: { VpcEndpointType?: string } }).Properties?.VpcEndpointType;
    // Interface endpoints set VpcEndpointType: 'Interface'; gateway endpoints
    // default the property (Gateway) and omit it in the synthesized template.
    if (type === 'Interface') iface += 1;
    else gateway += 1;
  }
  return { iface, gateway };
}

describe('finalizeVpc', () => {
  it('always provisions CloudWatch Logs and SSM interface endpoints, even with no BBs', () => {
    const template = synthWith(() => {});
    const { iface, gateway } = endpointCounts(template);
    assert.equal(gateway, 0);
    assert.equal(iface, 2); // Logs + SSM, always-on
    template.hasResourceProperties(IFACE, {
      VpcEndpointType: 'Interface',
      ServiceName: 'com.amazonaws.us-east-1.logs',
    });
    template.hasResourceProperties(IFACE, {
      VpcEndpointType: 'Interface',
      ServiceName: 'com.amazonaws.us-east-1.ssm',
    });
  });

  it('provisions the union of BB-declared endpoints plus the always-on pair', () => {
    const template = synthWith((scope) => {
      new FakeBB(scope, 'Kv', { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] });
      new FakeBB(scope, 'Bucket', { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.S3] });
      new FakeBB(scope, 'Job', { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SQS] });
      new FakeBB(scope, 'Db', {
        interfaceEndpoints: [
          ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
          ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
        ],
        subnetRole: 'isolated',
      });
    });
    const { iface, gateway } = endpointCounts(template);
    // Gateways: DynamoDB + S3.
    assert.equal(gateway, 2);
    // Interfaces: SQS + Secrets Manager + RDS Data + always-on Logs + SSM.
    assert.equal(iface, 5);
  });

  it('deduplicates endpoints requested by multiple BBs', () => {
    const template = synthWith((scope) => {
      new FakeBB(scope, 'Kv1', { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] });
      new FakeBB(scope, 'Kv2', { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] });
      new FakeBB(scope, 'Job1', { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SQS] });
      new FakeBB(scope, 'Job2', { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SQS] });
    });
    const { iface, gateway } = endpointCounts(template);
    // Two DynamoDB requests collapse to one gateway endpoint.
    assert.equal(gateway, 1);
    // Two SQS requests collapse to one; plus always-on Logs + SSM = 3.
    assert.equal(iface, 3);
  });

  it('dedups SSM even when a BB also declares it (no duplicate of the always-on pair)', () => {
    const template = synthWith((scope) => {
      new FakeBB(scope, 'AppSetting', { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SSM] });
    });
    const { iface } = endpointCounts(template);
    // BB's SSM + always-on SSM + always-on Logs => still just SSM + Logs.
    assert.equal(iface, 2);
  });

  it('provisions nothing when provisionEndpoints is false', () => {
    const template = synthWith(
      (scope) => {
        new FakeBB(scope, 'Kv', { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] });
      },
      { provisionEndpoints: false },
    );
    template.resourceCountIs(IFACE, 0);
  });
});

// We can't fully test CDK constructs without a Stack, but we can test
// the getVpcContext logic with mock constructs.

describe('VPC utilities', () => {
  it('getVpcContext returns undefined when no context set', () => {
    const fakeScope: any = { node: { scope: undefined } };
    assert.equal(getVpcContext(fakeScope), undefined);
  });

  it('getVpcContext walks up the scope tree', () => {
    const vpcContext = { vpc: 'mock-vpc', lambdaSecurityGroup: 'mock-sg', lambdaSubnets: {} };
    const parent: any = { node: { scope: undefined } };
    setVpcContext(parent, vpcContext as any);

    const child: any = { node: { scope: parent } };
    assert.equal(getVpcContext(child), vpcContext);
  });

  it('setVpcContext stores context on the scope', () => {
    const fakeScope: any = { node: { scope: undefined } };
    const vpcContext = { vpc: 'mock-vpc', lambdaSecurityGroup: 'mock-sg', lambdaSubnets: {} };
    setVpcContext(fakeScope, vpcContext as any);
    assert.equal(getVpcContext(fakeScope), vpcContext);
  });
});
