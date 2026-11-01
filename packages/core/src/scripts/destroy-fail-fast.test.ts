// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A destroy that can never succeed (no Region, missing or rejected
// credentials) stops at once instead of retrying for minutes.

import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createCdkOutput } from './cdk-output.js';
import { destroy, productionDestroyDeps } from './destroy.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import {
	deterministicDestroyFailure,
	runDestroyWithRetries,
	runSandboxDestroy,
	sandboxDestroyDeps,
} from './sandbox.js';

/** The variables that select an AWS target; cleared so only the test's files count. */
const AWS_TARGET_VARIABLES = [
	'AWS_REGION',
	'AWS_DEFAULT_REGION',
	'AWS_PROFILE',
	'AWS_DEFAULT_PROFILE',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
	'AMAZON_ACCESS_KEY_ID',
];

describe('destroy fails fast on a deterministic error', () => {
	let directory: string;
	let savedEnv: NodeJS.ProcessEnv;
	let savedCwd: string;

	beforeEach(async () => {
		savedEnv = { ...process.env };
		savedCwd = process.cwd();
		directory = await mkdtemp(join(tmpdir(), 'blocks-destroy-fail-fast-'));
		for (const name of AWS_TARGET_VARIABLES) delete process.env[name];
		process.env.HOME = directory;
		process.env.AWS_CONFIG_FILE = join(directory, 'config');
		process.env.AWS_SHARED_CREDENTIALS_FILE = join(directory, 'credentials');
		process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/noop';
		await writeFile(join(directory, 'config'), '');
		await writeFile(join(directory, 'credentials'), '');
		mock.method(console, 'log', () => {});
		mock.method(console, 'warn', () => {});
	});

	afterEach(async () => {
		mock.restoreAll();
		process.chdir(savedCwd);
		for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
		Object.assign(process.env, savedEnv);
		await rm(directory, { recursive: true, force: true });
	});

	it('stops after the first attempt, without a backoff or a stack lookup, when the failure is deterministic', async () => {
		const errors: string[] = [];
		mock.method(console, 'error', (...a: unknown[]) => {
			errors.push(a.join(' '));
		});
		let attempts = 0;
		let listed = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('npm exec cdk -- destroy exited with code 1');
				},
				listStacks: () => {
					listed++;
					return [{ stackName: 's' }];
				},
				emptyBuckets: async () => {},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				deterministicFailure: () => 'no AWS Region is set',
			}),
			/exited with code 1/,
		);
		assert.strictEqual(attempts, 1);
		assert.strictEqual(listed, 0);
		assert.deepStrictEqual(sleeps, []);
		assert.match(errors.join('\n'), /Destroy failed: no AWS Region is set\. Retrying can't fix that/);
	});

	it('keeps retrying a failure that is not deterministic', async () => {
		let attempts = 0;
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('bucket not empty');
				},
				listStacks: () => [],
				emptyBuckets: async () => {},
				sleep: async () => {},
				deterministicFailure: () => undefined,
			}),
		);
		assert.strictEqual(attempts, 3);
	});

	it('classifies CDK and SDK credential and Region failures, and nothing else', () => {
		for (const line of [
			'❌ zz-app-prod: destroy failed UnresolvedAccount',
			'Unable to resolve AWS account to use. It must be either configured when you define your CDK Stack, or through the environment',
			'Error: Region is missing',
			'Need to perform AWS calls for account 123456789012, but no credentials have been configured',
			'CredentialsProviderError: Could not load credentials from any providers',
			'ExpiredToken: The security token included in the request is expired',
			'InvalidClientTokenId: The security token included in the request is invalid.',
		]) {
			assert.ok(deterministicDestroyFailure(['some progress', line]), line);
		}
		for (const line of [
			'The bucket you tried to delete is not empty',
			'Too Many Requests (Service: ApiGateway, Status Code: 429)',
			'zz-app-UnresolvedAccountTable: DELETE_FAILED',
			'',
		]) {
			assert.strictEqual(deterministicDestroyFailure([line]), undefined, line);
		}
	});

	it('reads only the most recent run when it classifies a curated cdk run', async () => {
		const sink = { write: () => true };
		const output = createCdkOutput({ label: 'cdk destroy', level: 'quiet', stdout: sink, stderr: sink });
		await output.run(process.execPath, ['-e', "console.log('Error: Region is missing')"]);
		await assert.rejects(async () =>
			output.run(process.execPath, ['-e', "console.error('bucket not empty'); process.exit(1)"]),
		);
		assert.deepStrictEqual(output.lastRunLines(), ['bucket not empty']);
		assert.strictEqual(deterministicDestroyFailure(output.lastRunLines()), undefined);
	});

	it('wires the classification into both destroy paths', () => {
		const sandbox = sandboxDestroyDeps('/app/aws-blocks/index.cdk.ts', {}, {
			cfnFor: () => {
				throw new Error('unused');
			},
			s3: {} as never,
		});
		const production = productionDestroyDeps({ cdkAppPath: 'cdk.ts', projectRoot: '/app' }, {});
		for (const deps of [sandbox, production]) {
			assert.strictEqual(typeof deps.deterministicFailure, 'function');
			assert.strictEqual(deps.deterministicFailure?.(), undefined, 'nothing has run yet');
		}
	});

	it('assertAwsCredentials with requireRegion stops when no Region is set, without a probe', async () => {
		let probed = false;
		await assert.rejects(
			assertAwsCredentials({
				command: 'destroy',
				projectRoot: directory,
				requireRegion: true,
				probe: async () => {
					probed = true;
					return undefined;
				},
			}),
			/No AWS Region is set, so `npm run destroy` can't find the stack to delete/,
		);
		assert.strictEqual(probed, false);
	});

	it('names the invocation the user ran in the missing-Region error', async () => {
		await assert.rejects(
			assertAwsCredentials({
				command: 'destroy',
				invocation: 'blocks destroy',
				projectRoot: directory,
				requireRegion: true,
				probe: async () => undefined,
			}),
			/No AWS Region is set, so `blocks destroy` can't find the stack to delete\. .*re-run `blocks destroy`\./,
		);
	});

	it('production destroy stops before cdk when no Region is set', async () => {
		await assert.rejects(
			destroy({ cdkAppPath: join(directory, 'cdk.ts'), projectRoot: directory }),
			/No AWS Region is set/,
		);
	});

	it('sandbox destroy loads .env.local before the credential check, and requires a Region', async () => {
		await writeFile(join(directory, '.env.local'), 'AWS_REGION=eu-west-3\nAWS_PROFILE=zz-from-env-local\n');
		process.chdir(directory);
		const seen: Array<{ region?: string; profile?: string; requireRegion?: boolean }> = [];
		await assert.rejects(
			runSandboxDestroy('aws-blocks/index.cdk.ts', {
				checkCredentials: async (options) => {
					seen.push({
						region: process.env.AWS_REGION,
						profile: process.env.AWS_PROFILE,
						requireRegion: options.requireRegion,
					});
					throw new Error('stop after the check');
				},
				retryClients: async () => {
					throw new Error('must not run');
				},
				destroy: async () => {
					throw new Error('must not run');
				},
			}),
			/stop after the check/,
		);
		assert.deepStrictEqual(seen, [{ region: 'eu-west-3', profile: 'zz-from-env-local', requireRegion: true }]);
	});
});
