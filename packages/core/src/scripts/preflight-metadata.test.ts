// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { AwsCredentialIdentity } from '@smithy/types';
import type { AccountMetadataClientFactory, AccountMetadataTarget } from './account-metadata.js';
import {
	type AssertAwsCredentialsOptions,
	assertAwsCredentials,
	type CredentialProbe,
} from './preflight-credentials.js';

const BILLING_URL = 'https://settings.aws.com/billing';
const VERIFY_WORKSPACE = '(check that the selected workspace matches this target)';
/** The spending guidance is one line, so that it adds little to every run. */
const BILLING_LINE = `💳 Spending limit: ${BILLING_URL} ${VERIFY_WORKSPACE}`;
const CREDENTIALS: AwsCredentialIdentity = { accessKeyId: 'AKIAEXAMPLEFIXTURE', secretAccessKey: 'fixture-secret' };

function namedError(name: string, message = 'raw sdk detail arn:aws:iam::123456789012:user/alice'): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

type Response = () => Promise<unknown>;

/** A fake for the metadata clients that records how it was used. */
function fakeClients(account: Response, plan: Response) {
	const state = { targets: [] as AccountMetadataTarget[], destroyed: 0, signals: [] as AbortSignal[] };
	const factory: AccountMetadataClientFactory = async (target) => {
		state.targets.push(target);
		return {
			getAccountInformation: (signal) => {
				state.signals.push(signal);
				return account();
			},
			getAccountPlanState: (signal) => {
				state.signals.push(signal);
				return plan();
			},
			destroy: () => {
				state.destroyed++;
			},
		};
	};
	return { factory, state };
}

const NAMED = async () => ({ AccountId: '123456789012', AccountName: 'Starter project' });
const FREE_ACTIVE = async () => ({
	accountId: '123456789012',
	accountPlanType: 'FREE',
	accountPlanStatus: 'ACTIVE',
	accountPlanRemainingCredits: { amount: 87.5, unit: 'USD' },
});
const NEVER = () => new Promise<never>(() => {});

describe('deployment target summary', () => {
	let directory: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'blocks-preflight-metadata-'));
		env = {
			HOME: directory,
			AWS_CONFIG_FILE: join(directory, 'config'),
			AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
			AWS_REGION: 'eu-north-1',
			AWS_PROFILE: 'starter',
		};
		await writeFile(join(directory, 'config'), '[profile starter]\nregion = eu-north-1\n');
		await writeFile(join(directory, 'credentials'), '');
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	/** Run the check and return what it printed. */
	async function run(
		options: Partial<AssertAwsCredentialsOptions> = {},
	): Promise<{ log: string; warn: string; elapsed: number }> {
		const log = mock.method(console, 'log', () => {});
		const warn = mock.method(console, 'warn', () => {});
		const started = Date.now();
		try {
			await assertAwsCredentials({
				command: 'deploy',
				env,
				projectRoot: directory,
				probe: async () => CREDENTIALS,
				...options,
			});
			return {
				log: log.mock.calls.map((call) => call.arguments.join(' ')).join('\n'),
				warn: warn.mock.calls.map((call) => call.arguments.join(' ')).join('\n'),
				elapsed: Date.now() - started,
			};
		} finally {
			log.mock.restore();
			warn.mock.restore();
		}
	}

	for (const command of ['deploy', 'sandbox']) {
		it(`prints the profile, Region, account name and plan for ${command}`, async () => {
			const { factory, state } = fakeClients(NAMED, FREE_ACTIVE);
			const { log } = await run({ command, metadataClients: factory });
			assert.match(log, /Deployment target: AWS profile starter, Region eu-north-1/);
			assert.match(log, /Account name: Starter project$/m);
			assert.match(log, /Account plan: Free \(active\)$/m);
			assert.ok(log.split('\n').includes(BILLING_LINE), log);
			assert.strictEqual(log.split('\n').length, 4, log);
			assert.strictEqual(state.destroyed, 1);
		});
	}

	it('reads metadata with the profile, Region and credentials that STS verified', async () => {
		await writeFile(join(directory, 'cdk.json'), '{"profile":"from-cdk","region":"us-gov-west-1"}');
		const probed: [string, string | undefined][] = [];
		const probe: CredentialProbe = async (region, profile) => {
			probed.push([region, profile]);
			return CREDENTIALS;
		};
		const { factory, state } = fakeClients(NAMED, FREE_ACTIVE);
		const { log } = await run({ probe, metadataClients: factory });
		assert.deepStrictEqual(probed, [['us-gov-west-1', 'from-cdk']]);
		assert.deepStrictEqual(state.targets, [
			{ region: 'us-gov-west-1', profile: 'from-cdk', credentials: CREDENTIALS },
		]);
		assert.match(log, /AWS profile from-cdk, Region us-gov-west-1/);
	});

	for (const { name, account, plan, expectedName, expectedPlan } of [
		{
			name: 'denied',
			account: () => Promise.reject(namedError('AccessDeniedException')),
			plan: () => Promise.reject(namedError('AccessDeniedException')),
			expectedName: 'not available',
			expectedPlan: 'not available',
		},
		{
			name: 'unsupported',
			account: () => Promise.reject(namedError('UnknownOperationException')),
			plan: () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
			expectedName: 'not available',
			expectedPlan: 'not available',
		},
		{
			name: 'empty',
			account: async () => ({}),
			plan: async () => ({ $metadata: {} }),
			expectedName: 'not available',
			expectedPlan: 'not available',
		},
		{
			name: 'partial',
			account: async () => ({ AccountName: 'Starter project' }),
			plan: async () => ({ accountPlanType: 'PAID' }),
			expectedName: 'Starter project',
			expectedPlan: 'Paid',
		},
		{
			name: 'half failed',
			account: () => Promise.reject(namedError('AccessDeniedException')),
			plan: async () => ({ accountPlanType: 'FREE', accountPlanStatus: 'EXPIRED' }),
			expectedName: 'not available',
			expectedPlan: 'Free (expired)',
		},
		{
			name: 'malformed',
			account: async () => ({ AccountName: 42 }),
			plan: async () => ({ accountPlanType: 'GOLD', accountPlanStatus: 'ACTIVE' }),
			expectedName: 'not available',
			expectedPlan: 'not available',
		},
		{
			name: 'not an object',
			account: async () => null,
			plan: async () => 'FREE',
			expectedName: 'not available',
			expectedPlan: 'not available',
		},
		{
			name: 'blank name and unknown status',
			account: async () => ({ AccountName: '  \u0007 ' }),
			plan: async () => ({ accountPlanType: 'FREE', accountPlanStatus: 'PAUSED' }),
			expectedName: 'not available',
			expectedPlan: 'Free',
		},
	]) {
		it(`continues with ${name} metadata`, async () => {
			const { factory, state } = fakeClients(account, plan);
			const { log, warn } = await run({ metadataClients: factory });
			assert.ok(log.includes(`Account name: ${expectedName}\n`), log);
			assert.ok(log.includes(`Account plan: ${expectedPlan}\n`), log);
			assert.ok(log.includes(BILLING_URL) && log.includes(VERIFY_WORKSPACE), log);
			assert.strictEqual(warn, '');
			assert.strictEqual(state.destroyed, 1);
		});
	}

	it('stops waiting for metadata at the timeout, cancels the requests and closes the clients', async () => {
		const { factory, state } = fakeClients(NEVER, NEVER);
		const { log, elapsed } = await run({ metadataClients: factory, metadataTimeoutMs: 50 });
		assert.ok(elapsed < 1000, `took ${elapsed} ms`);
		assert.match(log, /Account name: not available$/m);
		assert.match(log, /Account plan: not available$/m);
		assert.ok(log.includes(BILLING_URL), log);
		assert.strictEqual(state.signals.length, 2);
		assert.ok(state.signals.every((signal) => signal.aborted));
		assert.strictEqual(state.destroyed, 1);
	});

	it('keeps the account name when only the plan read times out', async () => {
		const { factory, state } = fakeClients(NAMED, NEVER);
		const { log } = await run({ metadataClients: factory, metadataTimeoutMs: 50 });
		assert.match(log, /Account name: Starter project$/m);
		assert.match(log, /Account plan: not available$/m);
		assert.strictEqual(state.destroyed, 1);
	});

	it('continues when the metadata clients cannot be created', async () => {
		const { log } = await run({
			metadataClients: async () => {
				throw namedError('Error', 'Cannot find package @aws-sdk/client-account');
			},
		});
		assert.match(log, /Account name: not available$/m);
		assert.ok(log.includes(BILLING_URL), log);
	});

	it('closes the clients when a request throws synchronously', async () => {
		const { factory, state } = fakeClients(() => {
			throw namedError('TypeError');
		}, FREE_ACTIVE);
		const { log } = await run({ metadataClients: factory });
		assert.match(log, /Account name: not available$/m);
		assert.match(log, /Account plan: Free \(active\)$/m);
		assert.strictEqual(state.destroyed, 1);
	});

	it('prints no account ID, ARN, error text, credits or terminal control characters', async () => {
		const { factory } = fakeClients(
			async () => ({ AccountId: '123456789012', AccountName: '\u001b[31mStarter\u0007 project\u202e' }),
			() => Promise.reject(namedError('AccessDeniedException')),
		);
		const { log, warn } = await run({ metadataClients: factory });
		const output = `${log}\n${warn}`;
		assert.match(log, /Account name: \[31mStarter project$/m);
		assert.doesNotMatch(output, /123456789012|arn:aws|raw sdk detail|AccessDenied|AKIA|fixture-secret/);
		assert.doesNotMatch(output.replaceAll('\n', ''), /[\p{Cc}\p{Cf}]/u);
	});

	it('does not print plan credits or treat the plan as spending-limit state', async () => {
		const { factory } = fakeClients(NAMED, FREE_ACTIVE);
		const { log } = await run({ metadataClients: factory });
		assert.doesNotMatch(log, /87\.5|USD|credit/i);
	});

	it('offers the billing guidance without reading metadata when the probe returns no credentials', async () => {
		const { factory, state } = fakeClients(NAMED, FREE_ACTIVE);
		const { log } = await run({ probe: async () => {}, metadataClients: factory });
		assert.strictEqual(state.targets.length, 0);
		assert.match(log, /Deployment target: AWS profile starter, Region eu-north-1/);
		assert.match(log, /Account name: not available$/m);
		assert.ok(log.includes(BILLING_URL) && log.includes(VERIFY_WORKSPACE), log);
	});

	for (const [name, error] of [
		['network', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
		['inconclusive', namedError('ThrottlingException')],
	] as const) {
		it(`prints the target and billing guidance, without metadata, after a ${name} probe result`, async () => {
			const { factory, state } = fakeClients(NAMED, FREE_ACTIVE);
			const { log } = await run({
				probe: async () => {
					throw error;
				},
				metadataClients: factory,
			});
			assert.strictEqual(state.targets.length, 0);
			assert.match(log, /Deployment target: AWS profile starter, Region eu-north-1/);
			assert.ok(log.includes(BILLING_URL), log);
		});
	}

	it('does not read metadata or offer billing guidance when the credentials fail', async () => {
		const { factory, state } = fakeClients(NAMED, FREE_ACTIVE);
		await assert.rejects(
			run({
				probe: async () => {
					throw namedError('ExpiredToken');
				},
				metadataClients: factory,
				readAwsCliVersion: async () => 'aws-cli/2.32.0',
			}),
			/AWS credentials could not be verified/,
		);
		assert.strictEqual(state.targets.length, 0);
	});

	it('names environment access keys instead of a profile', async () => {
		delete env.AWS_PROFILE;
		env.AWS_ACCESS_KEY_ID = 'AKIAENVIRONMENT';
		env.AWS_SECRET_ACCESS_KEY = 'secret';
		const { factory } = fakeClients(NAMED, FREE_ACTIVE);
		const { log } = await run({ metadataClients: factory });
		assert.match(log, /Deployment target: access keys in AWS_ACCESS_KEY_ID, Region eu-north-1/);
		assert.doesNotMatch(log, /profile default|AKIAENVIRONMENT/);
	});

	it('names the default profile when nothing selects one', async () => {
		delete env.AWS_PROFILE;
		const { factory } = fakeClients(NAMED, FREE_ACTIVE);
		const { log } = await run({ metadataClients: factory });
		assert.match(log, /Deployment target: AWS profile default, Region eu-north-1/);
	});

	it('quotes a profile or Region that contains unusual characters', async () => {
		env.AWS_PROFILE = 'my profile\u001b[2J';
		env.AWS_REGION = 'eu-north-1\u001b[2J';
		const { factory } = fakeClients(NAMED, FREE_ACTIVE);
		const { log } = await run({ metadataClients: factory });
		assert.ok(log.includes('AWS profile "my profile\\u001b[2J", Region "eu-north-1\\u001b[2J"'), log);
		assert.ok(!log.includes('\u001b'), log);
	});

	it('explains how to set the Region for aws login when no Region is set', async () => {
		delete env.AWS_REGION;
		await writeFile(
			join(directory, 'config'),
			'[profile starter]\nlogin_session = arn:aws:iam::123456789012:user/u\n',
		);
		const probed: string[] = [];
		const { factory, state } = fakeClients(NAMED, FREE_ACTIVE);
		const { log, warn } = await run({
			probe: async (region) => {
				probed.push(region);
				return CREDENTIALS;
			},
			metadataClients: factory,
		});
		assert.deepStrictEqual(probed, []);
		assert.strictEqual(state.targets.length, 0);
		assert.match(warn, /Skipping the AWS credential pre-check/);
		assert.match(warn, /before you run `aws login`, set the profile Region to your project's Region/);
		assert.match(warn, /aws configure set region <region> --profile starter$/m);
		assert.match(warn, /If you change the profile Region after you sign in, run `aws login` again\./);
		assert.ok(warn.includes('https://settings.aws.com/projects'), warn);
		assert.doesNotMatch(warn, /123456789012/);
		assert.match(log, /Deployment target: AWS profile starter, Region not set/);
		assert.ok(log.includes(BILLING_URL), log);
	});

	it('prints a placeholder in the Region command for a profile that a shell could misread', async () => {
		delete env.AWS_REGION;
		env.AWS_PROFILE = '$(whoami)';
		const { warn } = await run({ metadataClients: fakeClients(NAMED, FREE_ACTIVE).factory });
		assert.match(warn, /aws configure set region <region> --profile <profile>$/m);
		assert.doesNotMatch(warn, /--profile \$\(whoami\)/);
	});
});
