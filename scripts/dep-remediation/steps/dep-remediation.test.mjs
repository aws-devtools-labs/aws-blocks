// Unit tests for the dep-remediation pure logic: the CI-outcome→summary mapping and the Bedrock
// invoke-layer retry classifier. Run under bare `node --test` (see package.json `test`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ModelError, ModelThrottledError, StructuredOutputError } from '@strands-agents/sdk';
import { describeModelError, isRetryableModelError, nextBackoffMs } from './bedrock-retry.mjs';
import { summarizeFailure } from './summarize.mjs';

describe('summarizeFailure', () => {
	// [label, build outcome, e2e outcome, expected summary]
	const CASES = [
		['build failed, e2e skipped', 'failure', 'skipped', 'the build failed'],
		['build failed, e2e empty', 'failure', undefined, 'the build failed'],
		['build ok, e2e failed', 'success', 'failure', 'the local e2e tests failed'],
		['both failed', 'failure', 'failure', 'both the build and the local e2e tests failed'],
		// A 'skipped' e2e must NOT be treated as an e2e break on its own — it rides on the build failure.
		['build ok, e2e skipped (defensive)', 'success', 'skipped', 'the post-bump verification failed'],
		['both success (defensive — should not be invoked)', 'success', 'success', 'the post-bump verification failed'],
	];
	for (const [label, build, e2e, expected] of CASES) {
		it(label, () => assert.equal(summarizeFailure(build, e2e), expected));
	}
});

describe('isRetryableModelError', () => {
	it('retries a Bedrock throttle', () => {
		assert.equal(isRetryableModelError(new ModelThrottledError('Too many tokens')), true);
	});
	it('retries a bare ModelError (transient mid-stream wrap)', () => {
		assert.equal(isRetryableModelError(new ModelError('Too many tokens, please wait')), true);
	});
	it('retries a 429 buried on a cause node', () => {
		const err = new Error('wrap', { cause: Object.assign(new Error('deep'), { $metadata: { httpStatusCode: 429 } }) });
		assert.equal(isRetryableModelError(err), true);
	});
	it('does NOT retry a terminal 4xx (AccessDenied — bad OIDC role)', () => {
		const err = Object.assign(new Error('no'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
		assert.equal(isRetryableModelError(err), false);
	});
	it('does NOT retry a StructuredOutputError', () => {
		assert.equal(isRetryableModelError(new StructuredOutputError('no schema-valid output')), false);
	});
	it('does NOT retry a plain Error', () => {
		assert.equal(isRetryableModelError(new Error('boom')), false);
	});
});

describe('nextBackoffMs', () => {
	it('stays within the equal-jitter window [0.5·base, 1.5·base) for attempt 1 (base 5s)', () => {
		for (let i = 0; i < 200; i++) {
			const ms = nextBackoffMs(1);
			assert.ok(ms >= 2500 && ms < 7500, `expected 2500..7500, got ${ms}`);
		}
	});
	it('clamps past the ladder end to the last base (attempt 99)', () => {
		const ms = nextBackoffMs(99);
		assert.ok(ms >= 45000 && ms < 135000, `expected ~90s window, got ${ms}`);
	});
});

describe('describeModelError', () => {
	it('surfaces the AWS class through a ModelError wrapper via the cause chain', () => {
		const err = new ModelError('opaque', {
			cause: Object.assign(new Error('rate exceeded'), {
				name: 'ThrottlingException',
				$metadata: { httpStatusCode: 429, requestId: 'abc-123' },
			}),
		});
		const desc = describeModelError(err);
		assert.match(desc, /ThrottlingException/);
		assert.match(desc, /httpStatusCode:429/);
		assert.match(desc, /requestId:abc-123/);
	});
});
