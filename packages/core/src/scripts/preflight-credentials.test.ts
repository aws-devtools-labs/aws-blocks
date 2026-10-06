// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { classifyError } from '../telemetry/trackCommand.js';
import { assertAwsCredentials, type CredentialProbe } from './preflight-credentials.js';

const CLI_WITH_LOGIN = 'aws-cli/2.32.0 Python/3.13.4 Darwin/25.6.0 exe/arm64';

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
			readAwsCliVersion: async () => CLI_WITH_LOGIN,
		});
	}

	/**
	 * Run the check with a probe that throws `errorName`. Returns the message and how
	 * often the AWS CLI version was read. Every credential failure must keep the
	 * existing telemetry code.
	 */
	async function failure(
		errorName: string,
		cli: string | Error = CLI_WITH_LOGIN,
	): Promise<{ message: string; cliChecks: number }> {
		let cliChecks = 0;
		const error = await assertAwsCredentials({
			command: 'deploy',
			env: { ...env, AWS_REGION: 'us-east-1' },
			projectRoot: directory,
			probe: async () => {
				throw namedError(errorName);
			},
			readAwsCliVersion: async () => {
				cliChecks++;
				if (cli instanceof Error) throw cli;
				return cli;
			},
		}).then(
			() => assert.fail('expected a credential error'),
			(rejection: unknown) => rejection,
		);
		assert.ok(error instanceof Error);
		assert.strictEqual(classifyError(error).code, 'CREDENTIALS_FAILED');
		return { message: error.message, cliChecks };
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

	it('recommends sign-up and aws login when no credentials are configured', async () => {
		const { message, cliChecks } = await failure('CredentialsProviderError');
		assert.match(message, /npm run deploy/);
		assert.match(message, /\(CredentialsProviderError\)/); // the name, for debugging
		assert.match(message, /No AWS credentials are configured for profile default/);
		assert.match(
			message,
			/New to AWS\? Create an account: https:\/\/signin\.aws\.amazon\.com\/signup\?request_type=builderId$/m,
		);
		assert.match(message, /Sign in: aws login --profile default$/m);
		assert.strictEqual(cliChecks, 1);
	});

	it('names the selected profile when it has only a Region, as before aws login', async () => {
		await writeFile(join(directory, 'config'), '[profile starter]\nregion = eu-north-1\n');
		env.AWS_PROFILE = 'starter';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /No AWS credentials are configured for profile starter/);
		assert.match(message, /aws login --profile starter/);
	});

	for (const [name, cli, note] of [
		['AWS CLI 2.32.0', CLI_WITH_LOGIN, null],
		['a later major version', 'aws-cli/3.0.1 Python/3.14.0 Linux/6.8 exe/x86_64', null],
		['AWS CLI 2.31', 'aws-cli/2.31.39 Python/3.13.7 Darwin/25.6.0 exe/arm64', /first update the AWS CLI/],
		['AWS CLI v1', 'aws-cli/1.33.12 Python/3.11.9 Linux/6.8 botocore/1.34.130', /first update the AWS CLI/],
		['no AWS CLI', Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' }), /first install the AWS CLI/],
		['a timed-out version check', Object.assign(new Error('Command failed'), { killed: true }), /needs AWS CLI/],
		['malformed version output', 'unexpected output', /needs AWS CLI version 2\.32\.0/],
	] as const) {
		it(`adapts the aws login hint to ${name}`, async () => {
			const { message } = await failure('CredentialsProviderError', cli);
			const line = message.split('\n').find((l) => l.includes('aws login --profile default'));
			assert.ok(line, message);
			if (note) assert.match(line, note);
			else assert.ok(line.endsWith('aws login --profile default'), line);
		});
	}

	it('does not check the AWS CLI when the credentials are valid', async () => {
		let cliChecks = 0;
		await assertAwsCredentials({
			command: 'deploy',
			env: { ...env, AWS_REGION: 'us-east-1' },
			projectRoot: directory,
			probe: async () => {},
			readAwsCliVersion: async () => {
				cliChecks++;
				throw Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' });
			},
		});
		assert.strictEqual(cliChecks, 0);
	});

	it('asks an aws login profile to sign in again, without assuming why the session ended', async () => {
		await writeFile(
			join(directory, 'config'),
			'[profile starter]\nlogin_session = arn:aws:iam::123456789012:role/WorkspaceAdminAccess\nregion = eu-north-1\n',
		);
		env.AWS_PROFILE = 'starter';
		for (const errorName of ['CredentialsProviderError', 'ExpiredToken']) {
			const { message } = await failure(errorName);
			assert.match(message, /sign-in session for profile starter has expired or could not be refreshed/);
			assert.match(message, /Sign in again: aws login --profile starter$/m);
			assert.doesNotMatch(message, /New to AWS|aws configure|aws sso login/);
			assert.doesNotMatch(message, /123456789012|WorkspaceAdminAccess/);
		}
	});

	for (const [name, config] of [
		[
			'an sso-session profile',
			'[profile dev]\nsso_session = corp\nsso_account_id = 123456789012\nsso_role_name = Admin\n',
		],
		[
			'a legacy SSO profile',
			'[profile dev]\nsso_start_url = https://corp.awsapps.com/start\nsso_region = us-east-1\n',
		],
	]) {
		it(`refreshes ${name} with aws sso login, not aws login`, async () => {
			await writeFile(join(directory, 'config'), config);
			env.AWS_PROFILE = 'dev';
			const { message, cliChecks } = await failure('ExpiredToken');
			assert.match(message, /Sign in again: aws sso login --profile dev$/m);
			assert.doesNotMatch(message, /aws login|New to AWS/);
			assert.doesNotMatch(message, /123456789012|awsapps/);
			assert.strictEqual(cliChecks, 0);
		});
	}

	it('follows source_profile to the profile that must sign in', async () => {
		await writeFile(
			join(directory, 'config'),
			'[profile app]\nrole_arn = arn:aws:iam::123456789012:role/Deploy\nsource_profile = base\n' +
				'[profile base]\nsso_session = corp\n',
		);
		env.AWS_PROFILE = 'app';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /Profile app assumes a role with credentials from profile base/);
		assert.match(message, /aws sso login --profile base$/m);
		assert.doesNotMatch(message, /123456789012|role\/Deploy/);
	});

	it('points a credential_process profile at its own tool, without printing the command', async () => {
		await writeFile(join(directory, 'config'), '[profile tool]\ncredential_process = get-creds --token s3cr3t\n');
		env.AWS_PROFILE = 'tool';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /credential_process command for profile tool/);
		assert.doesNotMatch(message, /s3cr3t|get-creds/);
		assert.doesNotMatch(message, /aws login|aws configure|New to AWS/);
	});

	it('asks to update access keys that AWS rejected, without printing them', async () => {
		await writeFile(
			join(directory, 'credentials'),
			'[ci]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI\n',
		);
		env.AWS_PROFILE = 'ci';
		const { message } = await failure('InvalidClientTokenId');
		assert.match(message, /AWS did not accept the access key for profile ci/);
		assert.match(message, /Update it: aws configure --profile ci$/m);
		assert.doesNotMatch(message, /AKIA|wJalr|aws login/);
	});

	it('reports expired environment credentials when no profile is selected', async () => {
		env.AWS_ACCESS_KEY_ID = 'ASIAEXAMPLE';
		env.AWS_SECRET_ACCESS_KEY = 'secret';
		env.AWS_SESSION_TOKEN = 'token';
		const { message } = await failure('ExpiredToken');
		assert.match(message, /temporary credentials in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY have expired/);
		assert.doesNotMatch(message, /ASIAEXAMPLE|profile default|aws login/);
	});

	it('uses the selected profile, not environment keys, as the SDK does', async () => {
		await writeFile(join(directory, 'config'), '[profile dev]\nsso_session = corp\n');
		env.AWS_PROFILE = 'dev';
		env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
		env.AWS_SECRET_ACCESS_KEY = 'secret';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /aws sso login --profile dev$/m);
		assert.doesNotMatch(message, /AWS_ACCESS_KEY_ID/);
	});

	it('uses the cdk.json profile for the guidance', async () => {
		await writeFile(join(directory, 'cdk.json'), '{"profile":"from-cdk"}');
		await writeFile(join(directory, 'config'), '[profile from-cdk]\nsso_session = corp\n');
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /aws sso login --profile from-cdk$/m);
	});

	it('reports a selected profile that is not in the AWS files', async () => {
		env.AWS_PROFILE = 'nope';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /Profile nope is not in your AWS config or credentials file/);
		assert.match(message, /Sign in to create it: aws login --profile nope$/m);
	});

	it('reports a web identity role from the environment without printing it', async () => {
		env.AWS_WEB_IDENTITY_TOKEN_FILE = join(directory, 'token');
		env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/Ci';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /AWS_WEB_IDENTITY_TOKEN_FILE/);
		assert.doesNotMatch(message, /123456789012|aws login|New to AWS/);
	});

	for (const profile of ['$(whoami)', '`id`', 'my profile', '@splat', '-x']) {
		it(`prints a placeholder, not the name, in commands for profile ${JSON.stringify(profile)}`, async () => {
			await writeFile(join(directory, 'config'), '[profile sso]\nsso_session = corp\n');
			env.AWS_PROFILE = profile;
			const { message } = await failure('CredentialsProviderError');
			const commands = message.split('\n').filter((line) => /\baws (login|sso login|configure) /.test(line));
			assert.ok(commands.length > 0, message);
			for (const command of commands) assert.match(command, /--profile <profile>(\s|$)/);
			assert.ok(message.includes(JSON.stringify(profile)), 'the prose still names the profile');
		});
	}

	it('prints a placeholder in aws sso login for a loadable profile that a shell could misread', async () => {
		// The SDK loads a profile named `@team`; PowerShell reads a leading `@` as splatting.
		await writeFile(join(directory, 'config'), '[profile @team]\nsso_session = corp\n');
		env.AWS_PROFILE = '@team';
		const { message } = await failure('CredentialsProviderError');
		assert.match(message, /session for profile "@team" has expired/);
		assert.match(message, /Sign in again: aws sso login --profile <profile>$/m);
	});

	it('treats a profile with access keys and SSO settings as access keys, as the SDK does', async () => {
		await writeFile(
			join(directory, 'config'),
			'[profile mixed]\nsso_session = corp\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret\n',
		);
		env.AWS_PROFILE = 'mixed';
		const { message } = await failure('InvalidClientTokenId');
		assert.match(message, /Update it: aws configure --profile mixed$/m);
		assert.doesNotMatch(message, /aws sso login/);
	});

	it("uses a source profile's own access keys before its role, as the SDK does", async () => {
		await writeFile(
			join(directory, 'config'),
			'[profile app]\nrole_arn = arn:aws:iam::123456789012:role/App\nsource_profile = base\n' +
				'[profile base]\nrole_arn = arn:aws:iam::123456789012:role/Base\nsource_profile = other\n' +
				'aws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret\n',
		);
		env.AWS_PROFILE = 'app';
		const { message } = await failure('InvalidClientTokenId');
		assert.match(message, /assumes a role with credentials from profile base/);
		assert.match(message, /Update it: aws configure --profile base$/m);
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

	for (const { name, error, expected } of [
		{
			// For example a denied AssumeRole: it does not prove that the deployment credentials resolved.
			name: 'an AccessDenied',
			error: namedError('AccessDenied', 'User: arn:aws:iam::123456789012:user/alice is not authorized'),
			expected: /Could not verify AWS credentials for `npm run sandbox` \(AccessDenied\)/,
		},
		{
			name: 'a credential provider that could not reach AWS, for example the SSO portal',
			error: namedError('CredentialsProviderError', 'Error: connect ECONNREFUSED 10.0.0.1:443'),
			expected: /Could not reach AWS to verify credentials for `npm run sandbox` \(ECONNREFUSED\)/,
		},
		{
			name: 'an SDK timeout',
			error: namedError('TimeoutError'),
			expected: /Could not reach AWS to verify credentials for `npm run sandbox` \(TimeoutError\)/,
		},
		{
			name: 'a Node.js connection error, reported by its code',
			error: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
			expected: /Could not reach AWS to verify credentials for `npm run sandbox` \(ECONNREFUSED\)/,
		},
		{
			name: 'an unclassified service error',
			error: namedError('ThrottlingException'),
			expected: /Could not verify AWS credentials for `npm run sandbox` \(ThrottlingException\)/,
		},
	]) {
		it(`warns and continues on ${name}`, async () => {
			const warn = mock.method(console, 'warn', () => {});
			try {
				await assert.doesNotReject(() =>
					check(async () => {
						throw error;
					}, 'sandbox'),
				);
				assert.strictEqual(warn.mock.callCount(), 1);
				const message = String(warn.mock.calls[0].arguments[0]);
				assert.match(message, expected);
				assert.doesNotMatch(message, /123456789012|10\.0\.0\.1|raw sdk detail/);
			} finally {
				warn.mock.restore();
			}
		});
	}

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
