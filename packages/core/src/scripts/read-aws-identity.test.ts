// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readAwsIdentity } from './preflight-credentials.js';

function namedError(name: string): Error {
	const err = new Error('raw sdk detail arn:aws:iam::123456789012:user/someone');
	err.name = name;
	return err;
}

describe('readAwsIdentity', () => {
	let directory: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'blocks-identity-'));
		env = {
			HOME: directory,
			AWS_CONFIG_FILE: join(directory, 'config'),
			AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
		};
		await writeFile(join(directory, 'config'), '[profile dev]\nregion = eu-west-1\n');
		await writeFile(join(directory, 'credentials'), '');
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it('returns the verified account, ARN, Region and credentials label', async () => {
		const identity = await readAwsIdentity({
			invocation: 'blocks whoami',
			env: { ...env, AWS_PROFILE: 'dev' },
			projectRoot: directory,
			probe: async (region, profile) => {
				assert.strictEqual(region, 'eu-west-1');
				assert.strictEqual(profile, undefined);
				return {
					credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
					account: '123456789012',
					callerArn: 'arn:aws:iam::123456789012:user/dev',
				};
			},
		});
		assert.deepStrictEqual(identity, {
			credentials: 'AWS profile dev',
			profile: 'dev',
			region: 'eu-west-1',
			account: '123456789012',
			arn: 'arn:aws:iam::123456789012:user/dev',
		});
	});

	it('sends no request when no Region is set', async () => {
		let probed = false;
		const identity = await readAwsIdentity({
			invocation: 'blocks whoami',
			env,
			projectRoot: directory,
			probe: async () => {
				probed = true;
				return undefined;
			},
		});
		assert.strictEqual(probed, false);
		assert.strictEqual(identity.region, null);
		assert.strictEqual(identity.account, undefined);
	});

	it('names the invocation in the guidance for missing credentials', async () => {
		await assert.rejects(
			readAwsIdentity({
				invocation: 'blocks whoami',
				env: { ...env, AWS_REGION: 'us-east-1' },
				projectRoot: directory,
				probe: async () => {
					throw namedError('CredentialsProviderError');
				},
				readAwsCliVersion: async () => 'aws-cli/2.32.0 Python/3.13.4 Linux/6 exe/x86_64',
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /could not be verified for `blocks whoami` \(CredentialsProviderError\)/);
				assert.match(error.message, /Then re-run `blocks whoami`\./);
				assert.doesNotMatch(error.message, /npm run|123456789012|raw sdk detail/);
				return true;
			},
		);
	});

	it('fails on a network error instead of continuing', async () => {
		await assert.rejects(
			readAwsIdentity({
				invocation: 'blocks whoami',
				env: { ...env, AWS_REGION: 'us-east-1' },
				projectRoot: directory,
				probe: async () => {
					throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
				},
			}),
			/Could not reach AWS to verify credentials for `blocks whoami` \(ECONNREFUSED\)/,
		);
	});
});
