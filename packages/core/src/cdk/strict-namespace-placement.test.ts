// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.strictNamespacePlacement`: what synth hands each compute so its
 * dispatcher serves only the API namespaces placed on it, and the warning when
 * it is off. The runtime side is in lambda-handler.test.ts.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { Construct } from 'constructs';
import { ApiNamespace } from '../api.js';
import { apiNamespaceFilterFromEnv } from '../api-placement.js';
import { applyStrictNamespacePlacement, type SharedGatewayOwner } from './blocks-backend.js';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import { ComputeBase } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import { getRegisteredConfigValue } from './config-registry.js';
import { Scope } from './index.js';
import { resolveNamespaceRoutes } from './shared-gateway.js';

const WARNING_ID = 'blocks:apigateway:bare-endpoint-serves-placed-namespaces';

/** A compute that records the env vars synth sets on it. */
class RecordingCompute extends ComputeBase {
	readonly env: Record<string, string> = {};

	constructor(scope: Construct, id: string) {
		// Test plumbing: a plain cdk.Stack is only a construct-tree parent here.
		super(id, { parent: scope as never });
	}

	setEnv(key: string, value: string): void {
		this.env[key] = value;
	}
	protected applyTracing(): void {}
	protected healthWidgets(): IWidget[][] {
		return [];
	}
	protected loggingWidgets(): IWidget[][] {
		return [];
	}
	protected tracingWidgets(): IWidget[][] {
		return [];
	}
}

function setup(defaults: BlocksDefaults) {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, 'Isolation');
	const owner = Object.assign(stack, { defaults }) as unknown as SharedGatewayOwner;
	const defaultCompute = new RecordingCompute(stack, 'DefaultCompute');
	const reportsCompute = new RecordingCompute(stack, 'ReportsCompute');
	const reportsScope = new Scope('reports-scope', { parent: stack as never });
	reportsScope._compute = reportsCompute;
	const apiScope = new Scope('api-scope', { parent: stack as never });
	apiScope._compute = defaultCompute;
	const backendModule = {
		api: new ApiNamespace(apiScope, 'api', () => ({ async ping() {} })),
		reports: new ApiNamespace(reportsScope, 'reports', () => ({ async ping() {} })),
	};
	const routes = resolveNamespaceRoutes(backendModule, defaultCompute, getComputes(stack));
	return { stack, owner, defaultCompute, reportsCompute, routes };
}

describe('applyStrictNamespacePlacement', () => {
	test('on: the default compute refuses a namespace placed on another compute; that compute serves only its own', () => {
		const { stack, owner, defaultCompute, reportsCompute, routes } = setup({
			...BlocksPresets.production,
			strictNamespacePlacement: true,
		});
		applyStrictNamespacePlacement(owner, defaultCompute, routes);

		const placement = getRegisteredConfigValue(stack, 'BLOCKS_API_NAMESPACE_COMPUTES');
		assert.strictEqual(typeof placement, 'string');
		assert.deepStrictEqual(JSON.parse(placement as string), { reports: reportsCompute.fullId });
		assert.deepStrictEqual(reportsCompute.env, { BLOCKS_API_COMPUTE_ID: reportsCompute.fullId });
		assert.deepStrictEqual(defaultCompute.env, {}, 'the default compute carries no id');

		// What each compute's dispatcher derives from that config and env.
		const onDefault = apiNamespaceFilterFromEnv({ BLOCKS_API_NAMESPACE_COMPUTES: placement as string });
		assert.ok(onDefault);
		assert.strictEqual(onDefault('reports'), false, 'the bare endpoint on the default compute refuses reports');
		assert.strictEqual(onDefault('api'), true);
		const onReports = apiNamespaceFilterFromEnv({
			BLOCKS_API_NAMESPACE_COMPUTES: placement as string,
			...reportsCompute.env,
		});
		assert.ok(onReports);
		assert.strictEqual(onReports('reports'), true);
		assert.strictEqual(onReports('api'), false);

		Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp(WARNING_ID));
	});

	test('off (the preset default): nothing is registered and synth warns', () => {
		const { stack, owner, defaultCompute, reportsCompute, routes } = setup(BlocksPresets.production);
		applyStrictNamespacePlacement(owner, defaultCompute, routes);

		assert.strictEqual(getRegisteredConfigValue(stack, 'BLOCKS_API_NAMESPACE_COMPUTES'), undefined);
		assert.deepStrictEqual(reportsCompute.env, {});
		Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp(`reports.*${WARNING_ID}`));
	});

	test('no namespace on its own compute: nothing is registered and no warning', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'NoPlacement');
		const owner = Object.assign(stack, { defaults: BlocksPresets.production }) as unknown as SharedGatewayOwner;
		const defaultCompute = new RecordingCompute(stack, 'DefaultCompute');
		applyStrictNamespacePlacement(owner, defaultCompute, new Map());

		assert.strictEqual(getRegisteredConfigValue(stack, 'BLOCKS_API_NAMESPACE_COMPUTES'), undefined);
		Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp(WARNING_ID));
	});
});

describe('apiNamespaceFilterFromEnv', () => {
	test('no placement config: every namespace is served', () => {
		assert.strictEqual(apiNamespaceFilterFromEnv({}), undefined);
	});

	test('a placement entry inherited from Object.prototype is not a placement', () => {
		const serves = apiNamespaceFilterFromEnv({ BLOCKS_API_NAMESPACE_COMPUTES: '{}' });
		assert.ok(serves);
		assert.strictEqual(serves('toString'), true);
		assert.strictEqual(serves('constructor'), true);
	});

	test('malformed placement config fails loudly', () => {
		for (const raw of ['not json', '[]', '{"reports":1}', 'null']) {
			assert.throws(
				() => apiNamespaceFilterFromEnv({ BLOCKS_API_NAMESPACE_COMPUTES: raw }),
				/must be a JSON object/,
			);
		}
	});
});
