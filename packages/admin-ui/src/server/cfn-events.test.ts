// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	type RawStackEvent,
	classifyEventsError,
	filterFailureEvents,
	pickRootCause,
	reconstructDeployments,
} from './cfn-events.js';

describe('classifyEventsError', () => {
	it('classifies expired tokens (name and message variants)', () => {
		const byName = new Error('boom');
		byName.name = 'ExpiredTokenException';
		assert.strictEqual(classifyEventsError(byName), 'CREDENTIALS_EXPIRED');
		assert.strictEqual(
			classifyEventsError(new Error('The security token included in the request is expired')),
			'CREDENTIALS_EXPIRED',
		);
	});

	it('classifies missing credentials', () => {
		const byName = new Error('boom');
		byName.name = 'CredentialsProviderError';
		assert.strictEqual(classifyEventsError(byName), 'CREDENTIALS_MISSING');
		assert.strictEqual(
			classifyEventsError(new Error('Could not load credentials from any providers')),
			'CREDENTIALS_MISSING',
		);
	});

	it('classifies missing stacks', () => {
		assert.strictEqual(
			classifyEventsError(new Error('Stack [my-app-prod] does not exist')),
			'STACK_NOT_FOUND',
		);
	});

	it('falls back to UNKNOWN', () => {
		assert.strictEqual(classifyEventsError(new Error('Throttling: rate exceeded')), 'UNKNOWN');
		assert.strictEqual(classifyEventsError('plain string'), 'UNKNOWN');
	});
});

function event(overrides: Partial<RawStackEvent>): RawStackEvent {
	return {
		Timestamp: new Date('2026-08-18T10:01:00Z'),
		LogicalResourceId: 'SomeResource',
		ResourceType: 'AWS::Lambda::Function',
		ResourceStatus: 'CREATE_FAILED',
		...overrides,
	};
}

describe('filterFailureEvents', () => {
	const window = { from: '2026-08-18T10:00:00Z', to: '2026-08-18T10:05:00Z' };

	it('keeps only failure statuses inside the window, newest first', () => {
		const events: RawStackEvent[] = [
			event({ Timestamp: new Date('2026-08-18T10:01:00Z'), LogicalResourceId: 'A' }),
			event({ Timestamp: new Date('2026-08-18T10:02:00Z'), LogicalResourceId: 'B', ResourceStatus: 'CREATE_COMPLETE' }),
			event({ Timestamp: new Date('2026-08-18T10:03:00Z'), LogicalResourceId: 'C', ResourceStatus: 'UPDATE_FAILED' }),
			event({ Timestamp: new Date('2026-08-18T09:00:00Z'), LogicalResourceId: 'BeforeWindow' }),
			event({ Timestamp: new Date('2026-08-18T11:00:00Z'), LogicalResourceId: 'AfterWindow' }),
		];
		const result = filterFailureEvents(events, window);
		assert.deepStrictEqual(
			result.map((e) => e.logicalResourceId),
			['C', 'A'],
		);
	});

	it('allows a grace period past finishedAt for trailing rollback events', () => {
		const events = [event({ Timestamp: new Date('2026-08-18T10:07:00Z'), LogicalResourceId: 'Trailing' })];
		const result = filterFailureEvents(events, window);
		assert.strictEqual(result.length, 1);
	});

	it('treats a missing window end as open-ended (in-progress deploy)', () => {
		const events = [event({ Timestamp: new Date('2026-08-18T23:00:00Z') })];
		assert.strictEqual(filterFailureEvents(events, { from: window.from }).length, 1);
	});

	it('marks cancellation cascades', () => {
		const events = [
			event({ ResourceStatusReason: 'Resource creation cancelled', LogicalResourceId: 'Cascade' }),
			event({ ResourceStatusReason: 'resource already exists', LogicalResourceId: 'Real' }),
		];
		const result = filterFailureEvents(events, window);
		assert.strictEqual(result.find((e) => e.logicalResourceId === 'Cascade')?.cancelled, true);
		assert.strictEqual(result.find((e) => e.logicalResourceId === 'Real')?.cancelled, false);
	});
});

describe('pickRootCause', () => {
	it('picks the earliest non-cancelled failure (list is newest first)', () => {
		const events = filterFailureEvents(
			[
				event({ Timestamp: new Date('2026-08-18T10:01:00Z'), LogicalResourceId: 'Root', ResourceStatusReason: 'boom' }),
				event({
					Timestamp: new Date('2026-08-18T10:02:00Z'),
					LogicalResourceId: 'Cascade',
					ResourceStatusReason: 'Resource creation cancelled',
				}),
				event({ Timestamp: new Date('2026-08-18T10:03:00Z'), LogicalResourceId: 'Later', ResourceStatusReason: 'followup' }),
			],
			{ from: '2026-08-18T10:00:00Z' },
		);
		assert.strictEqual(pickRootCause(events)?.logicalResourceId, 'Root');
	});

	it('falls back to the earliest cancellation when nothing else exists', () => {
		const events = filterFailureEvents(
			[event({ ResourceStatusReason: 'Resource creation cancelled', LogicalResourceId: 'OnlyCascade' })],
			{ from: '2026-08-18T10:00:00Z' },
		);
		assert.strictEqual(pickRootCause(events)?.logicalResourceId, 'OnlyCascade');
	});

	it('returns undefined for no events', () => {
		assert.strictEqual(pickRootCause([]), undefined);
	});
});

describe('reconstructDeployments', () => {
	const STACK = 'my-app-prod';

	function stackEvent(iso: string, status: string, reason?: string): RawStackEvent {
		return {
			Timestamp: new Date(iso),
			LogicalResourceId: STACK,
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: status,
			ResourceStatusReason: reason,
		};
	}

	it('groups stack-level events into episodes, newest first', () => {
		const events = [
			stackEvent('2026-08-01T10:00:00Z', 'CREATE_IN_PROGRESS', 'User Initiated'),
			stackEvent('2026-08-01T10:05:00Z', 'CREATE_COMPLETE'),
			stackEvent('2026-08-02T09:00:00Z', 'UPDATE_IN_PROGRESS', 'User Initiated'),
			stackEvent('2026-08-02T09:04:00Z', 'UPDATE_COMPLETE'),
		];
		const records = reconstructDeployments(events, STACK, 'production');
		assert.strictEqual(records.length, 2);
		assert.deepStrictEqual(
			records.map((r) => r.status),
			['SUCCEEDED', 'SUCCEEDED'],
		);
		assert.ok(records[0].startedAt > records[1].startedAt);
		assert.strictEqual(records[0].source, 'cloudformation-events');
		assert.strictEqual(records[0].finishedAt, '2026-08-02T09:04:00.000Z');
	});

	it('keeps rollback phases inside one episode and marks it ROLLED_BACK with a reason', () => {
		const events = [
			stackEvent('2026-08-03T10:00:00Z', 'UPDATE_IN_PROGRESS', 'User Initiated'),
			stackEvent('2026-08-03T10:02:00Z', 'UPDATE_ROLLBACK_IN_PROGRESS', 'Resource CREATE_FAILED: boom'),
			stackEvent('2026-08-03T10:05:00Z', 'UPDATE_ROLLBACK_COMPLETE'),
		];
		const records = reconstructDeployments(events, STACK, 'production');
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].status, 'ROLLED_BACK');
	});

	it('ignores resource-level events and leaves a trailing open episode IN_PROGRESS', () => {
		const events = [
			stackEvent('2026-08-04T10:00:00Z', 'UPDATE_IN_PROGRESS', 'User Initiated'),
			{
				Timestamp: new Date('2026-08-04T10:01:00Z'),
				LogicalResourceId: 'SomeFn',
				ResourceType: 'AWS::Lambda::Function',
				ResourceStatus: 'UPDATE_COMPLETE',
			},
		];
		const records = reconstructDeployments(events, STACK, 'production');
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].status, 'IN_PROGRESS');
		assert.strictEqual(records[0].finishedAt, undefined);
	});

	it('handles input in any order (DescribeStackEvents returns newest first)', () => {
		const events = [
			stackEvent('2026-08-01T10:05:00Z', 'CREATE_COMPLETE'),
			stackEvent('2026-08-01T10:00:00Z', 'CREATE_IN_PROGRESS', 'User Initiated'),
		];
		const records = reconstructDeployments(events, STACK, 'production');
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0].status, 'SUCCEEDED');
	});
});
