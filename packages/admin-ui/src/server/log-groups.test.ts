// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { type RawStackResource, resourcesToLogGroups } from './log-groups.js';

describe('resourcesToLogGroups', () => {
	it('maps explicit LogGroup resources and derives Lambda groups', () => {
		const resources: RawStackResource[] = [
			{
				LogicalResourceId: 'ApiHandler',
				PhysicalResourceId: 'my-app-ApiHandler-X1Y2',
				ResourceType: 'AWS::Lambda::Function',
			},
			{
				LogicalResourceId: 'AccessLogs',
				PhysicalResourceId: '/my-app/access-logs',
				ResourceType: 'AWS::Logs::LogGroup',
			},
			{ LogicalResourceId: 'Table', PhysicalResourceId: 'my-table', ResourceType: 'AWS::DynamoDB::Table' },
		];
		const groups = resourcesToLogGroups(resources);
		assert.deepStrictEqual(
			groups.map((g) => [g.name, g.source]),
			[
				['/aws/lambda/my-app-ApiHandler-X1Y2', 'lambda'],
				['/my-app/access-logs', 'explicit'],
			],
		);
	});

	it('dedupes by name with explicit winning over derived', () => {
		const resources: RawStackResource[] = [
			{ LogicalResourceId: 'Fn', PhysicalResourceId: 'my-fn', ResourceType: 'AWS::Lambda::Function' },
			{
				LogicalResourceId: 'FnLogGroup',
				PhysicalResourceId: '/aws/lambda/my-fn',
				ResourceType: 'AWS::Logs::LogGroup',
			},
		];
		const groups = resourcesToLogGroups(resources);
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].source, 'explicit');
		assert.strictEqual(groups[0].logicalResourceId, 'FnLogGroup');
	});

	it('explicit stays the winner regardless of resource order', () => {
		const resources: RawStackResource[] = [
			{
				LogicalResourceId: 'FnLogGroup',
				PhysicalResourceId: '/aws/lambda/my-fn',
				ResourceType: 'AWS::Logs::LogGroup',
			},
			{ LogicalResourceId: 'Fn', PhysicalResourceId: 'my-fn', ResourceType: 'AWS::Lambda::Function' },
		];
		const groups = resourcesToLogGroups(resources);
		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].source, 'explicit');
	});

	it('skips resources without physical or logical ids', () => {
		const resources: RawStackResource[] = [
			{ LogicalResourceId: 'Pending', ResourceType: 'AWS::Lambda::Function' },
			{ PhysicalResourceId: 'orphan', ResourceType: 'AWS::Lambda::Function' },
		];
		assert.deepStrictEqual(resourcesToLogGroups(resources), []);
	});

	it('returns groups sorted by name', () => {
		const resources: RawStackResource[] = [
			{ LogicalResourceId: 'B', PhysicalResourceId: 'zzz', ResourceType: 'AWS::Lambda::Function' },
			{ LogicalResourceId: 'A', PhysicalResourceId: 'aaa', ResourceType: 'AWS::Lambda::Function' },
		];
		const groups = resourcesToLogGroups(resources);
		assert.deepStrictEqual(
			groups.map((g) => g.name),
			['/aws/lambda/aaa', '/aws/lambda/zzz'],
		);
	});
});
