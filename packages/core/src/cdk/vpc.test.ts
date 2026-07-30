// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { getVpcContext, setVpcContext } from './vpc.js';

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
