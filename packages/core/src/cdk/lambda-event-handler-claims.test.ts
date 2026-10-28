// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CDK `Scope.registerLambdaEventHandler`: the one-handler-per-event-key rule
 * at synth. The Lambda runtime refuses a second handler for one
 * `{eventSource}:{identifier}`, but it only finds out when the handler module
 * loads — after deploy, on every cold start. The CDK layer claims the same key
 * when each block is constructed, so the conflict fails `cdk synth` instead.
 */
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { lambdaEventHandlerKey } from '../common/lambda-event-handlers.js';
import { Scope } from './index.js';
import { BLOCKS_BACKEND_ROOT } from './root-registry.js';

/** A stack branded as a backend root, the way BlocksStack/BlocksBackend brand themselves. */
function root(id: string): Stack {
	const stack = new Stack(new App(), id);
	(stack as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
	return stack;
}

afterEach(() => {
	delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
});

describe('CDK Scope.registerLambdaEventHandler: one handler per event key, enforced at synth', () => {
	test('a second claim on the same key throws, naming the key and both blocks', () => {
		const stack = root('App');
		const first = new Scope('job-a', { parent: stack as never });
		const second = new Scope('job-b', { parent: stack as never });
		first.registerLambdaEventHandler('aws:sqs', 'orders');
		assert.throws(
			() => second.registerLambdaEventHandler('aws:sqs', 'orders'),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /"aws:sqs:orders"/, 'names the event key');
				assert.match(e.message, /Scope 'job-b'/, 'names the block that claimed second');
				assert.match(e.message, /Building Block 'job-a'/, 'names the block that claimed first');
				assert.match(e.message, /already registered/);
				return true;
			},
		);
	});

	test('the handler argument is optional at synth, and ignored', () => {
		const stack = root('App');
		const a = new Scope('a', { parent: stack as never });
		a.registerLambdaEventHandler('blocks.cronjob', 'x', async () => {});
		const b = new Scope('b', { parent: stack as never });
		assert.throws(() => b.registerLambdaEventHandler('blocks.cronjob', 'x'), /already registered/);
	});

	test('another event source or another identifier is a different key', () => {
		const stack = root('App');
		const bb = new Scope('multi', { parent: stack as never });
		bb.registerLambdaEventHandler('aws:sqs', 'x');
		bb.registerLambdaEventHandler('blocks.cronjob', 'x');
		bb.registerLambdaEventHandler('aws:sqs', 'y');
	});

	test('claims are per backend root: two backends do not see each other', () => {
		const a = new Scope('job', { parent: root('AppA') as never });
		const b = new Scope('job', { parent: root('AppB') as never });
		a.registerLambdaEventHandler('aws:sqs', 'shared-name');
		b.registerLambdaEventHandler('aws:sqs', 'shared-name');
	});

	test('the key is the one the Lambda runtime routes on', () => {
		assert.strictEqual(
			lambdaEventHandlerKey('aws:cognito-idp', 'us-east-1_Pool'),
			'aws:cognito-idp:us-east-1_Pool',
		);
	});
});
