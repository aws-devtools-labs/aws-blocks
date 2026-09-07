// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for Logger.
 *
 * Logger owns no infrastructure. It targets the compute it resolves to: it
 * always calls `enableLogging()` (presence, so the per-compute Dashboard renders
 * the logs section) and, only when an explicit `retention` is given, forwards it
 * via `setLogRetention()`. The compute owns the actual log group and the
 * last-wins + conflict-warning policy (covered in `@aws-blocks/bb-lambda-compute`
 * tests), so here we assert only that Logger delegates correctly.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Logger } from './index.cdk.js';

/** Records the observability-seam calls bb-logger makes on its resolved compute. */
class SpyCompute {
	/** One entry per `enableLogging` call — the retention arg it was passed. */
	enableLoggingArgs: Array<number | undefined> = [];
	enableLogging(retentionDays?: number): void {
		this.enableLoggingArgs.push(retentionDays);
	}
}

// Minimal owner. Logger resolves `this.compute` to the root's `_defaultCompute`
// and reads `defaults`/`id` off the ambient stack; a spy compute is enough to
// observe the delegation without provisioning a real log group.
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

function setup(defaults: BlocksDefaults = BlocksPresets.production): { parent: Scope; compute: SpyCompute } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'LoggerStack', defaults);
	const parent = new Scope('app');
	return { parent, compute: stack._defaultCompute };
}

describe('Logger CDK (delegates observability to the compute)', () => {
	test('marks logging on the resolved compute with no retention when none is given', () => {
		const { parent, compute } = setup();
		new Logger(parent, 'log', { level: 'info' });
		assert.deepStrictEqual(compute.enableLoggingArgs, [undefined], 'enableLogging() called once, no retention');
	});

	test('a bare Logger enables logging with no retention (no clobber of the stack default)', () => {
		const { parent, compute } = setup();
		new Logger(parent, 'log');
		assert.deepStrictEqual(compute.enableLoggingArgs, [undefined]);
	});

	test('forwards an explicit retention to the compute', () => {
		const { parent, compute } = setup();
		new Logger(parent, 'log', { retention: 30 });
		assert.deepStrictEqual(compute.enableLoggingArgs, [30]);
	});

	test('two Loggers each forward their own value (compute enforces last-wins/conflict policy)', () => {
		const { parent, compute } = setup();
		new Logger(parent, 'first', { retention: 14 });
		new Logger(parent, 'second', { retention: 30 });
		assert.deepStrictEqual(compute.enableLoggingArgs, [14, 30]);
	});
});
