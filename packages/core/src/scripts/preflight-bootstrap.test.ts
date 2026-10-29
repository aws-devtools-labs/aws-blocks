// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { AwsCredentialIdentity } from '@smithy/types';
import type { BootstrapTarget, BootstrapVersionReader } from './preflight-bootstrap.js';
import { type AssertAwsCredentialsOptions, assertAwsCredentials } from './preflight-credentials.js';

const CREDENTIALS: AwsCredentialIdentity = { accessKeyId: 'AKIAEXAMPLEFIXTURE', secretAccessKey: 'fixture-secret' };
const ACCOUNT = '123456789012';

function namedError(name: string): Error {
	const err = new Error('raw sdk detail');
	err.name = name;
	return err;
}

/** A reader that records its calls and settles with `result`. */
function reader(result: () => Promise<unknown>) {
	const calls: [BootstrapTarget, string][] = [];
	const read: BootstrapVersionReader = async (target, name) => {
		calls.push([target, name]);
		return result();
	};
	return { read, calls };
}

const NOT_FOUND = async () => {
	throw namedError('ParameterNotFound');
};
const FOUND = async () => ({ Parameter: { Value: '30' } });

describe('CDK bootstrap check', () => {
	let directory: string;
	let env: NodeJS.ProcessEnv;
	let log: string[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'blocks-preflight-bootstrap-'));
		env = {
			HOME: directory,
			AWS_CONFIG_FILE: join(directory, 'config'),
			AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
			AWS_REGION: 'eu-south-2',
			AWS_PROFILE: 'starter',
		};
		await writeFile(join(directory, 'config'), '[profile starter]\nregion = eu-south-2\n');
		await writeFile(join(directory, 'credentials'), '');
		log = [];
		mock.method(console, 'log', (...args: unknown[]) => log.push(args.join(' ')));
		mock.method(console, 'warn', () => {});
	});

	afterEach(async () => {
		mock.restoreAll();
		await rm(directory, { recursive: true, force: true });
	});

	function check(read: BootstrapVersionReader, options: Partial<AssertAwsCredentialsOptions> = {}): Promise<void> {
		return assertAwsCredentials({
			command: 'deploy',
			env,
			projectRoot: directory,
			probe: async () => ({ credentials: CREDENTIALS, account: ACCOUNT }),
			metadataClients: async () => {
				throw new Error('no metadata in this test');
			},
			checkBootstrap: true,
			readBootstrapVersion: read,
			...options,
		});
	}

	async function failure(read: BootstrapVersionReader, options: Partial<AssertAwsCredentialsOptions> = {}) {
		const error = await check(read, options).then(
			() => assert.fail('expected the bootstrap check to stop the deploy'),
			(rejection: unknown) => rejection,
		);
		assert.ok(error instanceof Error);
		return error.message;
	}

	for (const command of ['deploy', 'sandbox']) {
		it(`stops ${command} with a ready-to-run bootstrap command when the version parameter is missing`, async () => {
			const { read, calls } = reader(NOT_FOUND);
			const message = await failure(read, { command });
			// The same Region, profile and verified credentials as the deploy, and the default qualifier.
			assert.deepEqual(calls, [
				[
					{ region: 'eu-south-2', profile: undefined, credentials: CREDENTIALS },
					'/cdk-bootstrap/hnb659fds/version',
				],
			]);
			assert.match(message, /CDK is not bootstrapped in Region eu-south-2 of account 123456789012/);
			// `--app=` keeps `cdk bootstrap` from synthesizing the Blocks app to find environments;
			// `--express` creates the bootstrap stack without waiting for each resource to stabilize.
			assert.match(message, /^ {4}npx cdk bootstrap aws:\/\/123456789012\/eu-south-2 --app= --express$/m);
			assert.match(message, new RegExp(`Then re-run \`npm run ${command}\`\\.$`));
			// The deployment target is printed before the deploy stops, so the user sees where it was going.
			assert.match(log.join('\n'), /Deployment target: AWS profile starter, Region eu-south-2/);
		});
	}

	it('checks the qualifier from the cdk.json context and passes the cdk.json profile', async () => {
		await writeFile(
			join(directory, 'cdk.json'),
			JSON.stringify({ profile: 'from-cdk', context: { '@aws-cdk/core:bootstrapQualifier': 'custom1' } }),
		);
		const { read, calls } = reader(NOT_FOUND);
		const message = await failure(read);
		assert.deepEqual(calls, [
			[{ region: 'eu-south-2', profile: 'from-cdk', credentials: CREDENTIALS }, '/cdk-bootstrap/custom1/version'],
		]);
		assert.match(message, /\/cdk-bootstrap\/custom1\/version not found/);
		// The user already set the qualifier where the check reads it.
		assert.doesNotMatch(message, /custom bootstrap qualifier/);
	});

	it('continues when the version parameter exists', async () => {
		const { read, calls } = reader(FOUND);
		await check(read);
		assert.equal(calls.length, 1);
	});

	for (const [name, result] of [
		['a denied read', async () => Promise.reject(namedError('AccessDeniedException'))],
		['a timeout', async () => Promise.reject(namedError('TimeoutError'))],
		['a network error', async () => Promise.reject(namedError('ECONNRESET'))],
		['a non-Error rejection', async () => Promise.reject('ParameterNotFound')],
	] as const) {
		it(`continues after ${name}, which does not prove that CDK is not bootstrapped`, async () => {
			const { read, calls } = reader(result);
			await check(read);
			assert.equal(calls.length, 1);
		});
	}

	it('skips the check when it is off, as for the destroy commands', async () => {
		const { read, calls } = reader(NOT_FOUND);
		await check(read, { checkBootstrap: false, accountDetails: false });
		assert.equal(calls.length, 0);
	});

	it('skips the check when the credential check did not return an account', async () => {
		const { read, calls } = reader(NOT_FOUND);
		await check(read, { probe: async () => ({ credentials: CREDENTIALS }) });
		await check(read, { probe: async () => undefined });
		assert.equal(calls.length, 0);
	});

	it('skips the check for a qualifier that the bootstrap template rejects, leaving the error to CDK', async () => {
		await writeFile(
			join(directory, 'cdk.json'),
			JSON.stringify({ context: { '@aws-cdk/core:bootstrapQualifier': 'has/slash' } }),
		);
		const { read, calls } = reader(NOT_FOUND);
		await check(read);
		assert.equal(calls.length, 0);
	});

	it('prints a placeholder instead of a Region that a shell could interpret', async () => {
		await writeFile(join(directory, 'cdk.json'), JSON.stringify({ region: 'eu-west-1$(touch x)' }));
		const message = await failure(reader(NOT_FOUND).read);
		assert.match(message, /^ {4}npx cdk bootstrap aws:\/\/123456789012\/<region> --app= --express$/m);
		assert.doesNotMatch(message, /touch/);
	});
});
