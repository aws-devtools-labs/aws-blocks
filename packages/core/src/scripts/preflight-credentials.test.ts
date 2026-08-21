// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { assertAwsCredentials } from './preflight-credentials.js';

describe('assertAwsCredentials', () => {
	it('resolves silently when the credential probe succeeds', async () => {
		let called = false;
		await assert.doesNotReject(() =>
			assertAwsCredentials('sandbox', async () => {
				called = true;
			}),
		);
		assert.strictEqual(called, true);
	});

	it('throws an actionable error naming the command when the probe rejects', async () => {
		const probeError = new Error('Could not load credentials from any providers');
		await assert.rejects(
			() =>
				assertAwsCredentials('sandbox', async () => {
					throw probeError;
				}),
			(err: Error) => {
				// Names the failing command so the message is copy-pasteable.
				assert.match(err.message, /npm run sandbox/);
				// Points at concrete remediation, not just "failed".
				assert.match(err.message, /aws configure|AWS_PROFILE|AWS_ACCESS_KEY_ID/);
				// Preserves the underlying cause for debugging.
				assert.match(err.message, /Could not load credentials from any providers/);
				return true;
			},
		);
	});

	it('interpolates the command name (deploy vs sandbox)', async () => {
		await assert.rejects(
			() =>
				assertAwsCredentials('deploy', async () => {
					throw new Error('boom');
				}),
			(err: Error) => {
				assert.match(err.message, /npm run deploy/);
				assert.doesNotMatch(err.message, /npm run sandbox/);
				return true;
			},
		);
	});

	it('handles a non-Error rejection value without crashing', async () => {
		await assert.rejects(
			// Throw a non-Error to exercise the String(error) fallback branch.
			() =>
				assertAwsCredentials('deploy', async () => {
					throw 'string failure';
				}),
			(err: Error) => {
				assert.match(err.message, /string failure/);
				return true;
			},
		);
	});
});
