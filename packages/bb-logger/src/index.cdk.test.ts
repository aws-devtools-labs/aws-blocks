// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for Logger.
 *
 * Logger owns **no** deploy-time infrastructure. Logging is always on — every
 * compute captures stdout to its own log group, retention is a compute-level
 * setting (`logRetention` → `defaults.logRetention`), and the log level is
 * per-instance runtime behavior (a `Logger`'s `level`, defaulting to `'info'`).
 * A `Logger`'s `level` / `defaultContext` are per-instance *runtime* behavior,
 * not deploy config. So
 * the CDK construct is a no-op placeholder that only lets `new Logger(scope, id)`
 * resolve in a CDK app, and any number of Loggers coexist freely. These tests
 * assert exactly that: construction succeeds, provisions nothing, and does not
 * touch the compute.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { Logger } from './index.cdk.js';

/** A spy compute that fails the test if the Logger ever pokes it. The new model
 * forbids the Logger from touching the compute — logging is always on. */
class SpyCompute {
	touched = false;
	enableTracing(): void {
		this.touched = true;
	}
}

// Minimal owner. A Logger resolves `id`/`defaults` off the ambient stack; the
// spy compute is here only to prove the Logger never calls into it.
class StubBlocksStack extends cdk.Stack {
	public readonly id: string;
	public readonly defaults: BlocksDefaults;
	public readonly _defaultCompute = new SpyCompute();
	constructor(scope: Construct, id: string, defaults: BlocksDefaults) {
		super(scope, id);
		this.id = id;
		this.defaults = defaults;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
	}
}

function setup(defaults: BlocksDefaults = BlocksPresets.production): {
	stack: StubBlocksStack;
	parent: Scope;
	compute: SpyCompute;
} {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'LoggerStack', defaults);
	const parent = new Scope('app');
	return { stack, parent, compute: stack._defaultCompute };
}

describe('Logger CDK (no-op placeholder)', () => {
	test('constructs without provisioning any infrastructure', () => {
		const { stack, parent } = setup();
		new Logger(parent, 'log', { level: 'info' });
		// Logger owns nothing — no log group, no anything.
		Template.fromStack(stack).resourceCountIs('AWS::Logs::LogGroup', 0);
	});

	test('never pokes the compute (logging is always on, not enabled by a Logger)', () => {
		const { parent, compute } = setup();
		new Logger(parent, 'log', { level: 'debug' });
		assert.strictEqual(compute.touched, false, 'Logger must not call into the compute');
	});

	test('multiple Loggers coexist freely', () => {
		const { stack, parent } = setup();
		new Logger(parent, 'first', { level: 'info' });
		new Logger(parent, 'second', { level: 'warn' });
		// Still no infrastructure, regardless of how many Loggers exist.
		Template.fromStack(stack).resourceCountIs('AWS::Logs::LogGroup', 0);
	});
});
