// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { registerVpcEndpoint, registerVpcRequirements, getVpcContext, setVpcContext, initializeVpc } from './vpc.js';

// We can't fully test CDK constructs without a Stack, but we can test
// the registerVpcEndpoint and getVpcContext logic with mock constructs.

describe('VPC utilities', () => {
  it('registerVpcEndpoint stores endpoint registrations on the scope', () => {
    const fakeScope: any = { node: { children: [] } };
    const fakeService = { name: 'dynamodb' };
    registerVpcEndpoint(fakeScope, { type: 'gateway', service: fakeService as any });
    const key = Symbol.for('BLOCKS_VPC_ENDPOINTS');
    assert.deepEqual(fakeScope[key], [
      { type: 'gateway', service: fakeService },
    ]);
  });

  it('registerVpcEndpoint appends when called multiple times', () => {
    const fakeScope: any = { node: { children: [] } };
    const fakeGw = { name: 'dynamodb' };
    const fakeIface = { name: 'com.amazonaws.secretsmanager' };
    registerVpcEndpoint(fakeScope, { type: 'gateway', service: fakeGw as any });
    registerVpcEndpoint(fakeScope, { type: 'interface', service: fakeIface as any });
    const key = Symbol.for('BLOCKS_VPC_ENDPOINTS');
    assert.deepEqual(fakeScope[key], [
      { type: 'gateway', service: fakeGw },
      { type: 'interface', service: fakeIface },
    ]);
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
