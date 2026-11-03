// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Tests for scripts/ci/hosting-teardown-replay.mjs, on log lines shaped like
// the E2E Hosting job logs.
//
// Run: node --test scripts/ci/hosting-teardown-replay.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHostingLog, replay } from './hosting-teardown-replay.mjs';

const T0 = Date.parse('2026-10-22T16:00:00Z') / 1000;
const ts = (s) => new Date((T0 + s) * 1000).toISOString().replace('Z', '0000Z');
const cfn = (s, status, type = 'AWS::ApiGateway::RestApi') =>
	`${ts(s)} blocks-hosting-spa-pr-1-spa |  75 | 4:45:17 PM | ${status.padEnd(23)} | ${type.padEnd(36)} | DefaultCompute/API (DefaultComputeAPI5E5CE44A) `;
const line = (s, text) => `${ts(s)} ${text}`;
const destroying = (s) => line(s, '\x1b[1m\u{1F5D1}\u{FE0F}  Destroying sandbox...\x1b[0m');

describe('parseHostingLog', () => {
	it('takes the destroy after the suite, not the pre-destroy before the deploy', () => {
		const log = [
			destroying(10), // sandbox-deploy's pre-destroy
			cfn(60, 'CREATE_IN_PROGRESS'),
			cfn(62, 'CREATE_COMPLETE'),
			destroying(500), // afterAll, printed twice
			destroying(501),
			cfn(510, 'DELETE_IN_PROGRESS', 'AWS::CloudFormation::Stack'),
			cfn(740, 'DELETE_IN_PROGRESS'),
			cfn(742, 'DELETE_COMPLETE'),
			destroying(760), // Cleanup sandbox
		].join('\n');
		assert.deepEqual(parseHostingLog(log), {
			ready: T0 + 501,
			waited: 0,
			failed: false,
			earlier: [],
			deletes: [239],
		});
	});

	it('replays a run made with a wait as without it', () => {
		const log = [
			cfn(60, 'CREATE_IN_PROGRESS'),
			line(500, "Waiting 240s to spread the matrix's stack deletes"),
			destroying(741),
			cfn(980, 'DELETE_IN_PROGRESS'),
		].join('\n');
		assert.deepEqual(parseHostingLog(log), {
			ready: T0 + 500,
			waited: 240,
			failed: false,
			earlier: [],
			deletes: [239],
		});
	});

	it('stops at the first DELETE_FAILED: later deletes are retries', () => {
		const log = [
			cfn(60, 'CREATE_IN_PROGRESS'),
			destroying(500),
			cfn(700, 'DELETE_IN_PROGRESS'),
			cfn(970, 'DELETE_FAILED'),
			cfn(1100, 'DELETE_IN_PROGRESS'),
		].join('\n');
		assert.deepEqual(parseHostingLog(log), {
			ready: T0 + 500,
			waited: 0,
			failed: true,
			earlier: [],
			deletes: [200],
		});
	});

	it('anchors on the last deploy when a Playwright retry deploys again', () => {
		const log = [
			cfn(60, 'CREATE_IN_PROGRESS'),
			destroying(300), // the retry's pre-destroy
			cfn(500, 'DELETE_IN_PROGRESS'),
			cfn(600, 'CREATE_IN_PROGRESS'),
			destroying(900),
			cfn(1100, 'DELETE_IN_PROGRESS'),
		].join('\n');
		assert.deepEqual(parseHostingLog(log), {
			ready: T0 + 900,
			waited: 0,
			failed: false,
			earlier: [T0 + 500],
			deletes: [200],
		});
	});

	it('returns null without a destroy after a deploy', () => {
		assert.equal(parseHostingLog([destroying(10), cfn(60, 'CREATE_IN_PROGRESS')].join('\n')), null);
	});
});

describe('replay', () => {
	const leg = (ready, deletes, earlier = []) => ({
		ready,
		deletes,
		earlier,
		end: ready + 300,
		start: T0,
		failed: false,
	});
	const run = { legs: { a: leg(100, [0]), b: leg(100, [10]), c: leg(400, [0], [T0 + 105]) }, othersEnd: T0 + 3600 };

	it('queues deletes one per 30 s, first in first out', () => {
		const r = replay(run, {});
		// a at 100; c's earlier delete (105) goes at 130 and is not counted; b (110) waits until 160; c at 400.
		assert.deepEqual(
			r.waits.map((w) => [w.leg, w.wait]),
			[
				['a', 0],
				['b', 50],
				['c', 0],
			],
		);
		assert.equal(r.cost, 0);
	});

	it('moves a leg to its slot only when it is ready sooner, and counts the runner time', () => {
		const r = replay(run, { b: 200, c: 300 });
		assert.deepEqual(
			r.waits.map((w) => [w.leg, w.wait]),
			[
				['a', 0],
				['b', 0],
				['c', 0],
			],
		);
		assert.equal(r.cost, 100); // b waits 100 s; c is ready after its slot
		assert.equal(r.hostingDelta, 0); // c still ends last
		assert.equal(r.gateDelta, 0);
	});
});
