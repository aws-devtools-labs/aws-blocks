// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test fixture: a child Scope that embeds its `fullId` directly into a CDK
 * construct ID.
 *
 * Why this matters
 * ----------------
 * Building Blocks routinely use their `fullId` as part of a construct ID, e.g.
 * a DSQL block creating its migration Lambda as
 * `new lambda.NodejsFunction(stack, `${this.fullId}DsqlMigrationFn`, ...)`.
 * CDK forbids unresolved tokens in construct IDs (it throws
 * "ID components may not include unresolved tokens" at synth time).
 *
 * `fullId` is derived from the enclosing stack name. In a nested-stack topology
 * (e.g. Amplify Gen2's `backend.createStack('blocks')`) that stack name is a
 * deploy-time token, so a naive `fullId` would carry a token and break synth.
 *
 * This fixture reproduces that exact pattern: importing it builds a construct
 * whose ID is `${this.fullId}Marker`. If `fullId` ever contains a token, this
 * side-effect import throws at synth time — which is what the test asserts must
 * NOT happen.
 */
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Scope } from '../index.js';
import type { ScopeParent } from '../../common/index.js';

class FullIdConstructBlock extends Scope {
  constructor(scope: ScopeParent, id: string) {
    super(id, { parent: scope });
    const stack = cdk.Stack.of(this);
    // Use fullId as a construct ID, the same way real Building Blocks do.
    new cdk.CfnResource(stack, `${this.fullId}Marker`, {
      type: 'AWS::CloudFormation::WaitConditionHandle',
    });
  }
}

const parent = (globalThis as any).CURRENT_BLOCKS_STACK;
new FullIdConstructBlock(parent, 'db');
