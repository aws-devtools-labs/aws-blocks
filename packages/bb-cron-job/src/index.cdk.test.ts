// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { isBlocksError } from '@aws-blocks/core';
import { CronJob, CronJobErrors } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

function setup(): { parent: Scope } {
	const app = new cdk.App();
	new StubBlocksStack(app, 'TestStack');
	return { parent: new Scope('app') };
}

test('CDK: CronJob rejects an invalid schedule at synth (rate(10 seconds))', () => {
	const { parent } = setup();
	assert.throws(
		() => new CronJob(parent, 'job', { schedule: 'rate(10 seconds)', handler: async () => {} }),
		(e: unknown) => isBlocksError(e, CronJobErrors.InvalidSchedule),
	);
});

test('CDK: CronJob rejects an invalid timezone at synth', () => {
	const { parent } = setup();
	assert.throws(
		() => new CronJob(parent, 'job', { schedule: 'rate(5 minutes)', timezone: 'Mars/Phobos', handler: async () => {} }),
		(e: unknown) => isBlocksError(e, CronJobErrors.InvalidTimezone),
	);
});

test('CDK: CronJob accepts a valid schedule and synthesizes a CfnSchedule', () => {
	const { parent } = setup();
	assert.doesNotThrow(() => new CronJob(parent, 'job', { schedule: 'rate(5 minutes)', handler: async () => {} }));
});
