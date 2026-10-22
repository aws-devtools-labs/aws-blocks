// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';

import { isThrottleReason, runDestroyWithRetries, stackDeleteThrottled, throttleBackoffDelay } from './sandbox.js';

// API Gateway allows one DeleteRestApi per 30s per account (a fixed quota), so
// parallel teardowns in one account fail with `Too Many Requests (Service:
// ApiGateway, Status Code: 429)` once CloudFormation's own SDK retries run out.
// The old fixed [60s, 120s] schedule gave up after 3 attempts, and parallel
// destroys retried in lockstep, colliding again. These pin the throttle path:
// jittered exponential backoff, bounded by a wall-clock budget, and ONLY for
// throttle-caused failures.

const MIN = 60_000;

/** A fake clock that each attempt advances by `attemptMs` (a throttled CFN delete runs ~5 min). */
function fakeClock(attemptMs: number) {
	let t = 0;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		attempt: () => {
			t += attemptMs;
		},
	};
}

describe('runDestroyWithRetries (throttled destroy)', () => {
	it('retries an API Gateway 429 destroy with jittered exponential backoff until it succeeds', async () => {
		const clock = fakeClock(5 * MIN);
		const sleeps: number[] = [];
		let attempts = 0;
		await runDestroyWithRetries({
			runDestroy: () => {
				attempts++;
				clock.attempt();
				// Fails 3 times (the old schedule's whole allowance), succeeds on the 4th.
				if (attempts <= 3)
					throw new Error('DELETE_FAILED: Too Many Requests (Service: ApiGateway, Status Code: 429)');
			},
			listStackNames: () => ['stackA'],
			emptyBuckets: async () => {},
			isThrottled: async () => true,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock.advance(ms);
			},
			now: clock.now,
			random: () => 0.5,
		});
		assert.strictEqual(attempts, 4, 'a throttled destroy gets more than the ordinary 3 attempts');
		// Equal jitter around 60s * 2^n: d/2 + 0.5 * d/2 = 0.75 d.
		assert.deepStrictEqual(sleeps, [45_000, 90_000, 180_000]);
	});

	it('spreads parallel throttled destroys apart (jitter), within [d/2, d] of the exponential step', async () => {
		const low = throttleBackoffDelay(0, {}, () => 0);
		const high = throttleBackoffDelay(0, {}, () => 0.999_999);
		assert.strictEqual(low, 30_000);
		assert.ok(high > 59_000 && high <= 60_000, `high=${high}`);
		// Exponential, capped at 5 min before jitter.
		assert.strictEqual(
			throttleBackoffDelay(1, {}, () => 0),
			60_000,
		);
		assert.strictEqual(
			throttleBackoffDelay(2, {}, () => 0),
			120_000,
		);
		assert.strictEqual(
			throttleBackoffDelay(10, {}, () => 1),
			300_000,
		);
	});

	it('gives up on a throttled destroy once the time budget is spent', async () => {
		const clock = fakeClock(5 * MIN);
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					clock.attempt();
					throw new Error('Too Many Requests (Service: ApiGateway, Status Code: 429)');
				},
				listStackNames: () => ['stackA'],
				emptyBuckets: async () => {},
				isThrottled: async () => true,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock.advance(ms);
				},
				now: clock.now,
				random: () => 1,
			}),
			/Too Many Requests/,
		);
		// Budget 20 min from the first failure (t=5): fail@5, +1 -> fail@11, +2 -> fail@18,
		// +4 -> fail@27 (> 5 + 20), stop. The wait that would start past the budget is never taken.
		assert.strictEqual(attempts, 4);
		assert.deepStrictEqual(sleeps, [60_000, 120_000, 240_000]);
		assert.strictEqual(clock.now(), 27 * MIN, 'gives up right after the attempt that follows the last wait');
	});

	it('never gives a non-throttle failure more than the ordinary [60s, 120s], whatever throttles came between', async () => {
		// Each attempt's classification, in order; the destroy always fails.
		for (const sequence of [
			[false, true, false, false],
			[true, false, true, false, false],
			[true, true, false, false, false],
		]) {
			let attempts = 0;
			const ordinarySleeps: number[] = [];
			let lastThrottled = false;
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						throw new Error('x');
					},
					listStackNames: () => ['stackA'],
					emptyBuckets: async () => {},
					isThrottled: async () => {
						lastThrottled = sequence[attempts - 1] ?? false;
						return lastThrottled;
					},
					sleep: async (ms) => {
						if (!lastThrottled) ordinarySleeps.push(ms);
					},
					random: () => 0.5,
				}),
			);
			assert.deepStrictEqual(ordinarySleeps, [60_000, 120_000], `sequence ${sequence.join(',')}`);
			assert.strictEqual(attempts, sequence.length, `sequence ${sequence.join(',')}`);
		}
	});

	it('keeps the ordinary [60s, 120s] schedule for a failure that is not a throttle', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('bucket not empty');
				},
				listStackNames: () => ['stackA'],
				emptyBuckets: async () => {},
				isThrottled: async () => false,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				random: () => 0.5,
			}),
			/bucket not empty/,
		);
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	it('treats a failure it cannot classify as not a throttle (ordinary schedule)', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('boom');
				},
				listStackNames: () => ['stackA'],
				emptyBuckets: async () => {},
				isThrottled: async () => {
					throw new Error('AccessDenied: cloudformation:DescribeStackEvents');
				},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
			/boom/,
		);
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	it('passes the attempt start time so a stale throttle from an earlier attempt is not counted', async () => {
		const clock = fakeClock(5 * MIN);
		const seen: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					clock.attempt();
					throw new Error('x');
				},
				listStackNames: () => ['stackA'],
				emptyBuckets: async () => {},
				isThrottled: async (_names: string[], since: number) => {
					seen.push(since);
					return false;
				},
				sleep: async (ms) => clock.advance(ms),
				now: clock.now,
			}),
		);
		// attempt 1 starts at 0; attempt 2 at 5 + 1 = 6 min; attempt 3 at 11 + 2 = 13 min.
		assert.deepStrictEqual(seen, [0, 6 * MIN, 13 * MIN]);
	});
});

describe('isThrottleReason', () => {
	it('matches the throttle reasons seen on DELETE_FAILED / CREATE_FAILED', () => {
		assert.ok(
			isThrottleReason(
				'Too Many Requests (Service: ApiGateway, Status Code: 429, Request ID: 1390791a) (SDK Attempt Count: 5)',
			),
		);
		assert.ok(
			isThrottleReason('Rate exceeded (Service: AmazonCloudFormation; Status Code: 400; Error Code: Throttling)'),
		);
		assert.ok(isThrottleReason('TooManyRequestsException: Too many requests'));
		assert.ok(
			isThrottleReason(
				'Request limit exceeded. (Service: Ec2, Status Code: 503, Error Code: RequestLimitExceeded)',
			),
		);
		assert.ok(
			isThrottleReason('Please reduce your request rate. (Service: S3, Status Code: 503, Error Code: SlowDown)'),
		);
	});

	it('does not match ordinary teardown failures', () => {
		assert.ok(!isThrottleReason(undefined));
		// A resource whose name contains "throttling" is not a throttle.
		assert.ok(!isThrottleReason('The following resource(s) failed to delete: [ApiThrottlingPlan1A2B3C]. '));
		assert.ok(!isThrottleReason('Role my-app-throttling-role is in use'));
		assert.ok(!isThrottleReason('The following resource(s) failed to delete: [DefaultComputeAPI5E5CE44A]. '));
		assert.ok(!isThrottleReason('The bucket you tried to delete is not empty'));
		assert.ok(!isThrottleReason('Network interface is currently in use'));
	});
});

type FakeEvent = {
	Timestamp: Date;
	LogicalResourceId: string;
	ResourceType: string;
	ResourceStatus: string;
	ResourceStatusReason?: string;
};

/** Fake CFN client serving DescribeStackEvents newest-first, `pageSize` events per page. */
function fakeCfn(eventsByStack: Record<string, FakeEvent[] | Error>, pageSize = 100) {
	const calls: string[] = [];
	const send = async (cmd: { constructor: { name: string }; input: { StackName: string; NextToken?: string } }) => {
		if (cmd.constructor.name !== 'DescribeStackEventsCommand')
			throw new Error(`unexpected ${cmd.constructor.name}`);
		const { StackName, NextToken } = cmd.input;
		calls.push(`${StackName}:${NextToken ?? 0}`);
		const events = eventsByStack[StackName];
		if (events instanceof Error) throw events;
		const start = Number(NextToken ?? 0);
		const page = (events ?? []).slice(start, start + pageSize);
		const next = start + pageSize < (events ?? []).length ? String(start + pageSize) : undefined;
		return { StackEvents: page, NextToken: next };
	};
	return { cfn: { send } as unknown as CloudFormationClient, calls };
}

const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 11, 0) + min * MIN);
const SINCE = at(0).getTime();

/** Events of one delete attempt that began at `startMin`, newest-first (the order CFN returns). */
function attempt(stack: string, startMin: number, reason: string | undefined): FakeEvent[] {
	return [
		{
			Timestamp: at(startMin + 20),
			LogicalResourceId: stack,
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: 'DELETE_FAILED',
			ResourceStatusReason: 'The following resource(s) failed to delete: [DefaultComputeAPI5E5CE44A]. ',
		},
		{
			Timestamp: at(startMin + 5),
			LogicalResourceId: 'DefaultComputeAPI5E5CE44A',
			ResourceType: 'AWS::ApiGateway::RestApi',
			ResourceStatus: 'DELETE_FAILED',
			ResourceStatusReason: reason,
		},
		{
			Timestamp: at(startMin),
			LogicalResourceId: stack,
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: 'DELETE_IN_PROGRESS',
			ResourceStatusReason: 'User Initiated',
		},
	];
}

const THROTTLE = 'Too Many Requests (Service: ApiGateway, Status Code: 429, Request ID: x) (SDK Attempt Count: 5)';

describe('stackDeleteThrottled', () => {
	it('is true when this attempt failed a resource delete on a throttle', async () => {
		const { cfn } = fakeCfn({ s: attempt('s', 1, THROTTLE) });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), true);
	});

	it('is false when this attempt failed for another reason', async () => {
		const { cfn } = fakeCfn({ s: attempt('s', 1, 'Network interface is currently in use') });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('ignores a throttle from an earlier attempt (this attempt never started a delete)', async () => {
		// The only delete attempt is 30 min before this one began (e.g. cdk failed to synth).
		const { cfn } = fakeCfn({ s: attempt('s', -30, THROTTLE) });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('stops at the start of this attempt, so an older throttle does not leak in', async () => {
		const events = [...attempt('s', 10, 'Network interface is currently in use'), ...attempt('s', -10, THROTTLE)];
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('is true if any of several stacks was throttled; a stack that is gone is skipped', async () => {
		const { cfn } = fakeCfn({
			gone: new Error('Stack [gone] does not exist'),
			ok: attempt('ok', 1, 'Network interface is currently in use'),
			hot: attempt('hot', 2, THROTTLE),
		});
		assert.strictEqual(await stackDeleteThrottled(cfn, ['gone', 'ok', 'hot'], SINCE), true);
	});

	it('does not read a stack-level summary or nested stack as a throttle', async () => {
		const [stackFailed, , started] = attempt('s', 1, undefined);
		const events: FakeEvent[] = [
			{
				...stackFailed,
				ResourceStatusReason: 'The following resource(s) failed to delete: [Nested]. Throttling',
			},
			{
				Timestamp: at(4),
				LogicalResourceId: 'Nested',
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'DELETE_FAILED',
				ResourceStatusReason: THROTTLE,
			},
			{
				Timestamp: at(3),
				LogicalResourceId: 'Eni',
				ResourceType: 'AWS::EC2::NetworkInterface',
				ResourceStatus: 'DELETE_FAILED',
				ResourceStatusReason: 'Network interface is currently in use',
			},
			started,
		];
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('ignores a recent throttle (inside the clock-skew window) when this attempt never started a delete', async () => {
		// Previous attempt: began 6 min ago, RestApi throttled 50s ago. This attempt (at SINCE) never reached DeleteStack.
		const events: FakeEvent[] = [
			{
				Timestamp: new Date(SINCE - 45_000),
				LogicalResourceId: 's',
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'DELETE_FAILED',
			},
			{
				Timestamp: new Date(SINCE - 50_000),
				LogicalResourceId: 'DefaultComputeAPI5E5CE44A',
				ResourceType: 'AWS::ApiGateway::RestApi',
				ResourceStatus: 'DELETE_FAILED',
				ResourceStatusReason: THROTTLE,
			},
			{
				Timestamp: new Date(SINCE - 6 * MIN),
				LogicalResourceId: 's',
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'DELETE_IN_PROGRESS',
			},
		];
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('throws a non-"does not exist" error after checking the other stacks', async () => {
		const denied = new Error('User is not authorized to perform: cloudformation:DescribeStackEvents');
		const { cfn, calls } = fakeCfn({ a: denied, b: attempt('b', 1, 'Network interface is currently in use') });
		await assert.rejects(stackDeleteThrottled(cfn, ['a', 'b'], SINCE), /not authorized/);
		assert.ok(
			calls.some((c) => c.startsWith('b:')),
			'still checked stack b',
		);
		// ...but a throttle found on another stack wins over the error.
		const hot = fakeCfn({ a: denied, b: attempt('b', 1, THROTTLE) });
		assert.strictEqual(await stackDeleteThrottled(hot.cfn, ['a', 'b'], SINCE), true);
	});

	it('throws when every stack is missing (e.g. stacks in another Region), so the caller warns', async () => {
		const { cfn } = fakeCfn({ a: new Error('Stack [a] does not exist'), b: new Error('Stack [b] does not exist') });
		await assert.rejects(stackDeleteThrottled(cfn, ['a', 'b'], SINCE), /none of the stacks/);
	});

	it('stops after a bounded number of pages', async () => {
		let pages = 0;
		const send = async () => {
			pages++;
			return {
				StackEvents: [
					{
						Timestamp: at(5),
						LogicalResourceId: 'Fn',
						ResourceType: 'AWS::Lambda::Function',
						ResourceStatus: 'DELETE_COMPLETE',
					},
				],
				NextToken: 'more',
			};
		};
		const cfn = { send } as unknown as CloudFormationClient;
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
		assert.strictEqual(pages, 10);
	});

	it('follows pagination back to the start of this attempt', async () => {
		const filler: FakeEvent[] = Array.from({ length: 5 }, (_, i) => ({
			Timestamp: at(3),
			LogicalResourceId: `Fn${i}`,
			ResourceType: 'AWS::Lambda::Function',
			ResourceStatus: 'DELETE_COMPLETE',
		}));
		const [stackFailed, apiFailed, started] = attempt('s', 1, THROTTLE);
		const { cfn, calls } = fakeCfn({ s: [stackFailed, ...filler, apiFailed, started] }, 2);
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), true);
		assert.ok(calls.length > 1, `paginated: ${calls.join(' ')}`);
	});
});
