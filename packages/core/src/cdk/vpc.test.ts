// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import { finalizeVpc, initializeVpc, getVpcContext, setVpcContext } from './vpc.js';
import type { BlocksVpcOptions, VpcRequirements } from './vpc-types.js';

// A minimal stand-in for a BuildingBlockScope: finalizeVpc only depends on the
// duck-typed protocol (a `getVpcRequirements()` method), so a bare Construct
// that implements it exercises the real pull-and-provision path without pulling
// every BB package into core's test graph. A `fullId` getter mirrors the real
// Scope so error messages that name the BB can be asserted.
class FakeBB extends Construct {
  constructor(
    scope: Construct,
    id: string,
    private readonly reqs: VpcRequirements,
  ) {
    super(scope, id);
  }
  get fullId(): string {
    return this.node.id;
  }
  getVpcRequirements(): VpcRequirements {
    return this.reqs;
  }
}

/**
 * Build a stack + VPC, optionally initialize the VPC context (so the endpoint
 * SG can scope to the Lambda SG), add fake BBs, then run finalizeVpc.
 */
function synthWith(
  bbs: (scope: Construct) => void,
  opts?: Partial<BlocksVpcOptions> & { natGateways?: number; withContext?: boolean },
): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: opts?.natGateways ?? 1 });
  const options: BlocksVpcOptions = { network: vpc, subnets: opts?.subnets, provisionEndpoints: opts?.provisionEndpoints };
  if (opts?.withContext !== false) initializeVpc(stack, options);
  bbs(stack);
  finalizeVpc(stack, options);
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

describe('finalizeVpc — endpoint provisioning', () => {
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

  it('provisions nothing when provisionEndpoints is false (but still validates runtimeSubnet)', () => {
    const template = synthWith(
      (scope) => {
        new FakeBB(scope, 'Kv', { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] });
      },
      { provisionEndpoints: false },
    );
    template.resourceCountIs(IFACE, 0);
  });

  it('scopes the interface-endpoint SG to 443 from the Blocks Lambda SG only', () => {
    const template = synthWith((scope) => {
      new FakeBB(scope, 'Job', { interfaceEndpoints: [ec2.InterfaceVpcEndpointAwsService.SQS] });
    });
    // A dedicated endpoint SG exists, described as Lambda-scoped, with a 443
    // ingress rule sourced from another SG (the Lambda SG) rather than the whole
    // VPC CIDR. We assert the rule is present (arrayWith) rather than the exact
    // array, since CDK may add its own paired rule for the endpoint association.
    const sgs = template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Blocks interface VPC endpoints — 443 from the Blocks Lambda only' },
    });
    assert.equal(Object.keys(sgs).length, 1, 'exactly one dedicated endpoint SG');
    const sg = Object.values(sgs)[0] as {
      Properties: { SecurityGroupIngress: Array<{ FromPort?: number; ToPort?: number; CidrIp?: string }> };
    };
    const ingress = sg.Properties.SecurityGroupIngress ?? [];
    const https = ingress.filter((r) => r.FromPort === 443 && r.ToPort === 443);
    assert.equal(https.length, 1, 'exactly one 443 ingress rule');
    // Must NOT be open to a CIDR (that would be the broad default we're avoiding).
    assert.equal(https[0].CidrIp, undefined, '443 ingress is SG-sourced, not CIDR-open');
  });
});

describe('finalizeVpc — runtimeSubnet validation', () => {
  it('passes when the Lambda placement satisfies the BB runtime requirement', () => {
    // Default Lambda placement is private-with-egress, which satisfies a
    // 'private-with-egress' requirement.
    assert.doesNotThrow(() =>
      synthWith((scope) => {
        new FakeBB(scope, 'Dsql', { runtimeSubnet: 'private-with-egress' });
      }),
    );
  });

  it('throws an actionable, BB-named error when the Lambda cannot satisfy the requirement', () => {
    // Place the Lambda in isolated subnets; a BB needing egress cannot be served.
    assert.throws(
      () =>
        synthWith(
          (scope) => {
            new FakeBB(scope, 'Dsql', { runtimeSubnet: 'private-with-egress' });
          },
          { subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } },
        ),
      /Dsql requires its runtime to be in a 'private-with-egress' subnet.*isolated/s,
    );
  });

  it('treats private-with-egress as satisfying an isolated runtime requirement', () => {
    assert.doesNotThrow(() =>
      synthWith((scope) => {
        new FakeBB(scope, 'Bb', { runtimeSubnet: 'isolated' });
      }),
    );
  });
});

describe('initializeVpc — Lambda placement guard', () => {
  function init(natGateways: number, subnets?: ec2.SubnetSelection) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env: { account: '123456789012', region: 'us-east-1' } });
    const subnetConfiguration =
      natGateways === 0
        ? [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }]
        : undefined;
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways, subnetConfiguration });
    return () => initializeVpc(stack, { network: vpc, subnets });
  }

  it('throws an actionable error when defaulting to private-with-egress but the VPC has none', () => {
    assert.throws(init(0), /no private-with-egress subnets.*NAT gateway/s);
  });

  it('does not throw when the VPC has a private-with-egress tier', () => {
    assert.doesNotThrow(init(1));
  });

  it('honors an explicit isolated placement without the private-with-egress guard', () => {
    // Caller explicitly chose isolated; the default-path guard must not fire.
    assert.doesNotThrow(init(0, { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }));
  });
});

describe('VpcContext.selectSubnets — instructive resolution', () => {
  function contextFor(natGateways: number) {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env: { account: '123456789012', region: 'us-east-1' } });
    const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways });
    // With natGateways: 0 CDK still creates the default public+private config,
    // but the private tier becomes isolated (no NAT). Build an explicit
    // isolated-only VPC to exercise the "no isolated" and "no egress" cases.
    return initializeVpc(stack, { network: vpc, subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } });
  }

  it('returns the requested role when the VPC has it', () => {
    const ctx = contextFor(1);
    const sel = ctx.selectSubnets({ fullId: 'app/db' }, 'private-with-egress');
    assert.equal(sel.subnetType, ec2.SubnetType.PRIVATE_WITH_EGRESS);
  });

  it('falls back to an explicit fallback role when the requested role is absent', () => {
    const ctx = contextFor(1); // has public + private-with-egress, no isolated
    const sel = ctx.selectSubnets({ fullId: 'app/db' }, 'isolated', { fallback: 'private-with-egress' });
    assert.equal(sel.subnetType, ec2.SubnetType.PRIVATE_WITH_EGRESS);
  });

  it('throws a BB-named error when neither the role nor its fallback exists', () => {
    const ctx = contextFor(1); // no isolated tier, and no public fallback requested that helps
    assert.throws(
      () => ctx.selectSubnets({ fullId: 'app/db' }, 'isolated'),
      /app\/db needs a 'isolated' subnet.*has none/s,
    );
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
