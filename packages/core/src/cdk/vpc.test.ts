// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { registerVpcGatewayEndpoint, registerVpcInterfaceEndpoint, registerVpcRequirements, getVpcContext, setVpcContext } from './vpc.js';

// We can't fully test CDK constructs without a Stack, but we can test
// the registration and getVpcContext logic with mock constructs.

describe('VPC utilities', () => {
  it('registerVpcGatewayEndpoint stores gateway endpoints on the scope', () => {
    const fakeScope: any = { node: { children: [] } };
    registerVpcGatewayEndpoint(fakeScope, ec2.GatewayVpcEndpointAwsService.DYNAMODB);
    const key = Symbol.for('BLOCKS_VPC_GATEWAY_ENDPOINTS');
    assert.equal(fakeScope[key].length, 1);
    assert.equal(fakeScope[key][0], ec2.GatewayVpcEndpointAwsService.DYNAMODB);
  });

  it('registerVpcGatewayEndpoint appends when called multiple times', () => {
    const fakeScope: any = { node: { children: [] } };
    registerVpcGatewayEndpoint(fakeScope, ec2.GatewayVpcEndpointAwsService.DYNAMODB);
    registerVpcGatewayEndpoint(fakeScope, ec2.GatewayVpcEndpointAwsService.S3);
    const key = Symbol.for('BLOCKS_VPC_GATEWAY_ENDPOINTS');
    assert.equal(fakeScope[key].length, 2);
    assert.equal(fakeScope[key][0], ec2.GatewayVpcEndpointAwsService.DYNAMODB);
    assert.equal(fakeScope[key][1], ec2.GatewayVpcEndpointAwsService.S3);
  });

  it('registerVpcInterfaceEndpoint stores interface endpoints on the scope', () => {
    const fakeScope: any = { node: { children: [] } };
    registerVpcInterfaceEndpoint(fakeScope, ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
    const key = Symbol.for('BLOCKS_VPC_INTERFACE_ENDPOINTS');
    assert.equal(fakeScope[key].length, 1);
    assert.equal(fakeScope[key][0], ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER);
  });

  it('registerVpcRequirements stores subnet role on the scope', () => {
    const fakeScope: any = { node: { children: [] } };
    registerVpcRequirements(fakeScope, { subnetRole: 'isolated' });
    const key = Symbol.for('BLOCKS_VPC_REQUIREMENTS');
    assert.deepEqual(fakeScope[key], { subnetRole: 'isolated' });
  });

  it('getVpcContext returns undefined when no context set', () => {
    const fakeScope: any = { node: { scope: undefined } };
    assert.equal(getVpcContext(fakeScope), undefined);
  });

  it('getVpcContext walks up the scope tree', () => {
    const vpcContext = { vpc: 'mock-vpc', lambdaSecurityGroup: 'mock-sg', lambdaSubnets: {} };
    const parent: any = { node: { scope: undefined } };
    const key = Symbol.for('BLOCKS_VPC_CONTEXT');
    parent[key] = vpcContext;

    const child: any = { node: { scope: parent } };
    assert.equal(getVpcContext(child), vpcContext);
  });
});
