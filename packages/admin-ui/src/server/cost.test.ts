// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	DEPLOYMENT_TYPE_TAG,
	STACK_NAME_TAG,
	buildCostQuery,
	evaluateTagActivation,
	mapCostResults,
} from './cost.js';

describe('evaluateTagActivation', () => {
	it('requires Active status, not mere existence', () => {
		const activation = evaluateTagActivation([
			{ TagKey: STACK_NAME_TAG, Status: 'Inactive' },
			{ TagKey: DEPLOYMENT_TYPE_TAG, Status: 'Active' },
		]);
		assert.deepStrictEqual(activation, { stackNameTagActive: false, deploymentTypeTagActive: true });
	});
});

describe('buildCostQuery (attribution ladder)', () => {
	const now = new Date('2026-08-19T12:00:00Z');

	it('prefers the stack-name tag when active and a stack is known', () => {
		const query = buildCostQuery(
			{ stackNameTagActive: true, deploymentTypeTagActive: true },
			'sandbox',
			'my-stack',
			now,
		);
		assert.strictEqual(query.attribution, 'stack-tag');
		assert.deepStrictEqual(query.filter, { tagKey: STACK_NAME_TAG, tagValue: 'my-stack' });
		assert.strictEqual(query.end, '2026-08-19');
		assert.strictEqual(query.start, '2026-07-20');
	});

	it('falls back to deployment-type when no stack name is resolvable', () => {
		const query = buildCostQuery({ stackNameTagActive: true, deploymentTypeTagActive: true }, 'sandbox', undefined, now);
		assert.strictEqual(query.attribution, 'deployment-type-tag');
		assert.deepStrictEqual(query.filter, { tagKey: DEPLOYMENT_TYPE_TAG, tagValue: 'sandbox' });
	});

	it('falls back to unattributed account totals when nothing is active', () => {
		const query = buildCostQuery({ stackNameTagActive: false, deploymentTypeTagActive: false }, 'sandbox', 'my-stack', now);
		assert.strictEqual(query.attribution, 'account-unattributed');
		assert.strictEqual(query.filter, undefined);
	});
});

describe('mapCostResults', () => {
	it('maps grouped daily results into days, service totals, and total', () => {
		const mapped = mapCostResults([
			{
				TimePeriod: { Start: '2026-08-17' },
				Groups: [
					{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '0.10', Unit: 'USD' } } },
					{ Keys: ['Amazon DynamoDB'], Metrics: { UnblendedCost: { Amount: '0.05', Unit: 'USD' } } },
				],
			},
			{
				TimePeriod: { Start: '2026-08-18' },
				Groups: [{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '0.20', Unit: 'USD' } } }],
			},
		]);
		assert.deepStrictEqual(mapped.days, [
			{ date: '2026-08-17', amount: 0.15 },
			{ date: '2026-08-18', amount: 0.2 },
		]);
		assert.deepStrictEqual(mapped.byService, [
			{ service: 'AWS Lambda', amount: 0.3 },
			{ service: 'Amazon DynamoDB', amount: 0.05 },
		]);
		assert.strictEqual(mapped.total, 0.35);
		assert.strictEqual(mapped.currency, 'USD');
	});

	it('drops zero-cost services and handles ungrouped totals', () => {
		const mapped = mapCostResults([
			{
				TimePeriod: { Start: '2026-08-18' },
				Groups: [{ Keys: ['Free Service'], Metrics: { UnblendedCost: { Amount: '0.0', Unit: 'USD' } } }],
			},
			{ TimePeriod: { Start: '2026-08-19' }, Total: { UnblendedCost: { Amount: '1.25', Unit: 'USD' } } },
		]);
		assert.deepStrictEqual(mapped.byService, []);
		assert.strictEqual(mapped.total, 1.25);
	});

	it('handles empty results', () => {
		const mapped = mapCostResults([]);
		assert.deepStrictEqual(mapped, { days: [], byService: [], total: 0, currency: undefined });
	});
});
