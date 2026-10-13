// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { assertAwsCredentials, type CredentialProbe } from './preflight-credentials.js';

/** Build an Error with a specific `name`, as the AWS SDK throws. */
function namedError(name: string, message = 'raw sdk detail'): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

describe('assertAwsCredentials', () => {
	let directory: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'blocks-preflight-'));
		env = {
			HOME: directory,
			AWS_CONFIG_FILE: join(directory, 'config'),
			AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
		};
		await writeFile(join(directory, 'config'), '');
		await writeFile(join(directory, 'credentials'), '');
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	/** Run the check and return the Regions that the probe received. */
	async function probedRegions(command = 'deploy'): Promise<string[]> {
		const regions: string[] = [];
		await assertAwsCredentials({
			command,
			env,
			projectRoot: directory,
			probe: async (region) => {
				regions.push(region);
			},
		});
		return regions;
	}

	function check(probe: CredentialProbe, command = 'deploy'): Promise<void> {
		return assertAwsCredentials({
			command,
			env: { ...env, AWS_REGION: 'us-east-1' },
			projectRoot: directory,
			probe,
		});
	}

	it('checks credentials when the selected profile is the only source of Region', async () => {
		await writeFile(join(directory, 'config'), '[profile deployment]\nregion = eu-west-1\n');
		env.AWS_PROFILE = 'deployment';
		const original = { ...env };
		assert.deepStrictEqual(await probedRegions('sandbox'), ['eu-west-1']);
		assert.deepStrictEqual(env, original);
	});

	for (const fixture of [
		{
			name: 'uses the default profile when AWS_PROFILE is not set',
			config: '[default]\nregion=ap-south-1',
			expected: 'ap-south-1',
		},
		{
			name: 'uses the credentials file before the config file, as CDK does',
			config: '[profile deployment]\nregion=eu-west-1',
			credentials: '[deployment]\nregion=eu-north-1',
			profile: 'deployment',
			expected: 'eu-north-1',
		},
		{
			name: 'uses the default profile Region when the selected profile has no Region',
			config: '[default]\nregion=eu-west-1\n[profile deployment]\noutput=json',
			profile: 'deployment',
			expected: 'eu-west-1',
		},
		{
			name: 'keeps a GovCloud Region',
			config: '[profile deployment]\nregion=us-gov-west-1',
			profile: 'deployment',
			expected: 'us-gov-west-1',
		},
	]) {
		it(fixture.name, async () => {
			await writeFile(join(directory, 'config'), fixture.config);
			await writeFile(join(directory, 'credentials'), fixture.credentials ?? '');
			if (fixture.profile) env.AWS_PROFILE = fixture.profile;
			assert.deepStrictEqual(await probedRegions(), [fixture.expected]);
		});
	}

	it('uses AWS_REGION, then AWS_DEFAULT_REGION, before profile Regions', async () => {
		await writeFile(join(directory, 'config'), '[default]\nregion=ap-south-1');
		env.AWS_DEFAULT_REGION = 'eu-west-1';
		assert.deepStrictEqual(await probedRegions(), ['eu-west-1']);
		env.AWS_REGION = 'cn-north-1';
		assert.deepStrictEqual(await probedRegions(), ['cn-north-1']);
	});

	it('does not use CDK_DEFAULT_REGION as an input', async () => {
		env.CDK_DEFAULT_REGION = 'us-east-1';
		const warn = mock.method(console, 'warn', () => {});
		try {
			assert.deepStrictEqual(await probedRegions(), []);
		} finally {
			warn.mock.restore();
		}
	});

	it('reads the profile again on each call', async () => {
		await writeFile(
			join(directory, 'config'),
			'[profile first]\nregion=eu-west-1\n[profile second]\nregion=cn-north-1',
		);
		env.AWS_PROFILE = 'first';
		assert.deepStrictEqual(await probedRegions(), ['eu-west-1']);
		env.AWS_PROFILE = 'second';
		assert.deepStrictEqual(await probedRegions(), ['cn-north-1']);
	});

	it('resolves silently when the credential probe succeeds', async () => {
		let calledRegion: string | undefined;
		await assert.doesNotReject(() =>
			check(async (region) => {
				calledRegion = region;
			}, 'sandbox'),
		);
		assert.strictEqual(calledRegion, 'us-east-1');
	});

	it('throws actionable guidance on a real credential error, naming the command', async () => {
		await assert.rejects(
			() =>
				check(async () => {
					throw namedError('CredentialsProviderError');
				}, 'sandbox'),
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
			() =>
				check(async () => {
					throw namedError('ExpiredToken');
				}),
			(err: Error) => {
				assert.match(err.message, /npm run deploy/);
				assert.match(err.message, /aws sso login|AWS_PROFILE/);
				return true;
			},
		);
	});

	it('does NOT leak the raw error message (ARN / account id)', async () => {
		const arnMessage =
			'User: arn:aws:iam::123456789012:user/alice is not authorized to perform sts:GetCallerIdentity';
		await assert.rejects(
			() =>
				check(async () => {
					throw namedError('InvalidClientTokenId', arnMessage);
				}),
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
				check(async () => {
					throw namedError('TimeoutError');
				}, 'sandbox'),
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
		try {
			assert.deepStrictEqual(await probedRegions('sandbox'), []);
			const message = String(warn.mock.calls[0].arguments[0]);
			assert.match(message, /Skipping the AWS credential pre-check/);
			assert.match(message, /AWS_REGION/);
		} finally {
			warn.mock.restore();
		}
	});
});
