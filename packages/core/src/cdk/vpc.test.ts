// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { registerVpcRequirements, getVpcContext, setVpcContext, initializeVpc } from './vpc.js';

// We can't fully test CDK constructs without a Stack, but we can test
// the registerVpcRequirements and getVpcContext logic with mock constructs.

describe('VPC utilities', () => {
  it('registerVpcRequirements stores requirements on the scope', () => {
    const fakeScope: any = { node: { children: [] } };
    registerVpcRequirements(fakeScope, {
      endpoints: [{ service: 'dynamodb', type: 'gateway' }],
    });
    // The key is a Symbol, so check the scope has the data
    const key = Symbol.for('BLOCKS_VPC_REQUIREMENTS');
    assert.deepEqual(fakeScope[key], {
      endpoints: [{ service: 'dynamodb', type: 'gateway' }],
    });
  });

  it('registerVpcRequirements merges when called multiple times', () => {
    const fakeScope: any = { node: { children: [] } };
    registerVpcRequirements(fakeScope, {
      endpoints: [{ service: 'dynamodb', type: 'gateway' }],
    });
    registerVpcRequirements(fakeScope, {
      endpoints: [{ service: 's3', type: 'gateway' }],
      subnetRole: 'isolated',
    });
    const key = Symbol.for('BLOCKS_VPC_REQUIREMENTS');
    assert.deepEqual(fakeScope[key], {
      endpoints: [
        { service: 'dynamodb', type: 'gateway' },
        { service: 's3', type: 'gateway' },
      ],
      subnetRole: 'isolated',
    });
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
