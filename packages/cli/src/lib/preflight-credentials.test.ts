// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { assertAwsCredentials, resolveProbeRegion } from './preflight-credentials.js';

const REGION_ENV = { AWS_REGION: 'us-east-1' } as NodeJS.ProcessEnv;

/** Build an Error with a specific `name`, as the AWS SDK throws. */
function namedError(name: string, message = 'raw sdk detail'): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

describe('resolveProbeRegion', () => {
	it('prefers AWS_REGION', () => {
		assert.strictEqual(resolveProbeRegion({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'us-east-2' }), 'eu-west-1');
	});

	it('falls back to AWS_DEFAULT_REGION', () => {
		assert.strictEqual(resolveProbeRegion({ AWS_DEFAULT_REGION: 'ap-south-1' }), 'ap-south-1');
	});

	it('returns null when neither is set (caller then skips the probe)', () => {
		assert.strictEqual(resolveProbeRegion({}), null);
	});
});

describe('assertAwsCredentials', () => {
	it('resolves silently when the credential probe succeeds', async () => {
		let calledRegion: string | undefined;
		await assert.doesNotReject(() =>
			assertAwsCredentials(
				'sandbox',
				async (region) => {
					calledRegion = region;
				},
				REGION_ENV,
			),
		);
		assert.strictEqual(calledRegion, 'us-east-1');
	});

	it('throws actionable guidance on a real credential error, naming the command', async () => {
		await assert.rejects(
			() => assertAwsCredentials('sandbox', async () => { throw namedError('CredentialsProviderError'); }, REGION_ENV),
			(err: Error) => {
				assert.match(err.message, /npm run sandbox/);
				assert.match(err.message, /aws configure|AWS_PROFILE|AWS_ACCESS_KEY_ID/);
				assert.match(err.message, /CredentialsProviderError/); // the name, for debugging
				return true;
			},
		);
	});

	it('treats an expired token as a credential error', async () => {
		await assert.rejects(
			() => assertAwsCredentials('deploy', async () => { throw namedError('ExpiredToken'); }, REGION_ENV),
			(err: Error) => {
				assert.match(err.message, /npm run deploy/);
				assert.match(err.message, /aws sso login|AWS_PROFILE/);
				return true;
			},
		);
	});

	it('does NOT leak the raw error message (ARN / account id)', async () => {
		const arnMessage = 'User: arn:aws:iam::123456789012:user/alice is not authorized to perform sts:GetCallerIdentity';
		await assert.rejects(
			() => assertAwsCredentials('deploy', async () => { throw namedError('InvalidClientTokenId', arnMessage); }, REGION_ENV),
			(err: Error) => {
				assert.doesNotMatch(err.message, /arn:aws:iam/);
				assert.doesNotMatch(err.message, /123456789012/);
				return true;
			},
		);
	});

	it('does not throw on a network/service error — warns and continues', async () => {
		const warn = mock.method(console, 'warn', () => {});
		try {
			await assert.doesNotReject(() =>
				assertAwsCredentials('sandbox', async () => { throw namedError('TimeoutError'); }, REGION_ENV),
			);
			assert.ok(
				warn.mock.calls.some((c) => String(c.arguments[0]).includes('Could not verify')),
				'should warn that credentials could not be verified',
			);
		} finally {
			warn.mock.restore();
		}
	});

	it('skips the probe (with a warning) when no region is resolvable', async () => {
		const warn = mock.method(console, 'warn', () => {});
		let probed = false;
		try {
			await assertAwsCredentials('sandbox', async () => { probed = true; }, {});
			assert.strictEqual(probed, false, 'probe must not run without a region');
			assert.ok(
				warn.mock.calls.some((c) => String(c.arguments[0]).includes('Skipping the AWS credential pre-check')),
				'should warn that the pre-check was skipped',
			);
		} finally {
			warn.mock.restore();
		}
	});
});
