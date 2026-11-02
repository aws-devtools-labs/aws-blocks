// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `registerConfig`: one value per key per backend. Config keys derived from a
 * block id fold case and map non-alphanumerics to `_` (`sanitizeConfigKey`), so
 * two blocks can map to one key (`orders-a` / `orders_a`). Before this check the
 * second registration silently replaced the first, both blocks read one
 * resource at runtime, and the app broke after deploy. Now synth fails, naming
 * the key and both constructs. Re-registering from the same construct, or the
 * same value from another, stays allowed; framework keys shared by design go
 * through `registerSharedConfig` and keep last-one-wins.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { registerConfig, registerSharedConfig } from './config-registry.js';
import { BLOCKS_BACKEND_ROOT } from './root-registry.js';

/** A stack branded as a backend root, the way BlocksStack/BlocksBackend brand themselves. */
function root(id = 'App'): cdk.Stack {
	const stack = new cdk.Stack(new cdk.App(), id);
	(stack as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
	return stack;
}

/** The registry's entries, read the way finalizeConfigRegistry does (keyed by a global Symbol). */
function entries(stack: cdk.Stack): Map<string, unknown> {
	const state = (stack as unknown as Record<symbol, { entries: Map<string, unknown> }>)[
		Symbol.for('BLOCKS_CONFIG_REGISTRY')
	];
	return state.entries;
}

describe('registerConfig: one value per key per backend', () => {
	test('another construct registering the same key with a different value fails, naming both', () => {
		const stack = root();
		const a = new Construct(stack, 'orders-a');
		const b = new Construct(stack, 'orders_a');
		registerConfig(a, 'BLOCKS_QUEUE_URL_APP_ORDERS_A', 'https://sqs/one');
		assert.throws(
			() => registerConfig(b, 'BLOCKS_QUEUE_URL_APP_ORDERS_A', 'https://sqs/two'),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /"BLOCKS_QUEUE_URL_APP_ORDERS_A"/, 'names the key');
				assert.match(e.message, /'App\/orders-a'/, 'names the first construct');
				assert.match(e.message, /'App\/orders_a'/, 'names the second construct');
				assert.match(e.message, /rename one/);
				return true;
			},
		);
		assert.strictEqual(entries(stack).get('BLOCKS_QUEUE_URL_APP_ORDERS_A'), 'https://sqs/one', 'never replaced');
	});

	test('names Building Blocks by fullId when the construct has one', () => {
		const stack = root();
		const a = Object.assign(new Construct(stack, 'a'), { fullId: 'app-orders-a' });
		const b = Object.assign(new Construct(stack, 'b'), { fullId: 'app-orders_a' });
		registerConfig(a, 'K', 'one');
		assert.throws(() => registerConfig(b, 'K', 'two'), /'app-orders-a'.*'app-orders_a'/s);
	});

	test('the same value from another construct is allowed (same literal, same token, equal JSON)', () => {
		const stack = root();
		const a = new Construct(stack, 'a');
		const b = new Construct(stack, 'b');
		registerConfig(a, 'LITERAL', 'us-east-1');
		registerConfig(b, 'LITERAL', 'us-east-1');
		registerConfig(a, 'TOKEN', stack.region);
		registerConfig(b, 'TOKEN', stack.region);
		registerConfig(a, 'JSON', { tier: 'gold', n: 1 });
		registerConfig(b, 'JSON', { tier: 'gold', n: 1 });
	});

	test('the same construct re-registering a key replaces its own value', () => {
		const stack = root();
		const a = new Construct(stack, 'a');
		registerConfig(a, 'K', 'first');
		registerConfig(a, 'K', 'second');
		assert.strictEqual(entries(stack).get('K'), 'second');
	});

	test('two different CDK tokens are different values', () => {
		const stack = root();
		const qa = new cdk.aws_sqs.Queue(stack, 'QA');
		const qb = new cdk.aws_sqs.Queue(stack, 'QB');
		registerConfig(qa, 'BLOCKS_QUEUE_URL_X', qa.queueUrl);
		assert.throws(() => registerConfig(qb, 'BLOCKS_QUEUE_URL_X', qb.queueUrl), /already registered/);
	});

	test('keys are per backend root: two backends register the same key independently', () => {
		const a = new Construct(root('A'), 'job');
		const b = new Construct(root('B'), 'job');
		registerConfig(a, 'K', 'one');
		registerConfig(b, 'K', 'two');
	});

	test('registerSharedConfig keeps last-one-wins for framework keys shared by design', () => {
		const stack = root();
		const spa = new Construct(stack, 'Spa');
		const docs = new Construct(stack, 'Docs');
		registerSharedConfig(spa, 'BLOCKS_PUBLIC_ORIGIN', 'https://spa.example');
		registerSharedConfig(docs, 'BLOCKS_PUBLIC_ORIGIN', 'https://docs.example');
		assert.strictEqual(entries(stack).get('BLOCKS_PUBLIC_ORIGIN'), 'https://docs.example');
	});
});
