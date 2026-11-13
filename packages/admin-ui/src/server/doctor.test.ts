// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { DoctorCheck } from '../contract/v1.js';
import type { LocalDevServerStatus } from './detect.js';
import {
	type CredentialsProbe,
	type DoctorCheckInput,
	type StackProbe,
	buildDoctorChecks,
	labelStackCandidates,
	runDoctor,
} from './doctor.js';

const healthyServer: LocalDevServerStatus = {
	serverUp: true,
	serverUrl: 'http://localhost:3000',
	port: 3000,
	portSource: 'server-script',
	namespaces: ['api', 'admin'],
	bbDataPresent: true,
};

/** A fully healthy environment; each test overrides only what it is about. */
function input(overrides: Partial<DoctorCheckInput> = {}): DoctorCheckInput {
	return {
		projectRoot: '/tmp/my-app',
		projectName: 'my-app',
		projectVia: 'explicit',
		localDevServer: healthyServer,
		profile: 'dev',
		region: 'us-east-1',
		credentials: { kind: 'ok', accountId: '123456789012' },
		stackCandidates: ['my-app-prod'],
		stacks: [
			{ stage: 'production', stackName: 'my-app-prod', probe: { kind: 'deployed', stackName: 'my-app-prod' } },
		],
		...overrides,
	};
}

function byId(checks: DoctorCheck[], id: string): DoctorCheck {
	const check = checks.find((c) => c.id === id);
	assert.ok(check, `expected a check with id "${id}", got: ${checks.map((c) => c.id).join(', ')}`);
	return check;
}

/** The invariant every check must satisfy: a non-ok status names a next action. */
function assertRemediationInvariant(checks: DoctorCheck[]): void {
	for (const check of checks) {
		if (check.status === 'ok') {
			assert.strictEqual(check.remediation, undefined, `${check.id}: ok checks carry no remediation`);
		} else {
			assert.ok(
				check.remediation && check.remediation.length > 0,
				`${check.id}: status "${check.status}" must carry a remediation`,
			);
		}
	}
}

describe('buildDoctorChecks — healthy environment', () => {
	it('reports every check ok', () => {
		const checks = buildDoctorChecks(input());
		assertRemediationInvariant(checks);
		assert.deepStrictEqual(
			checks.map((c) => c.status),
			checks.map(() => 'ok'),
		);
		assert.deepStrictEqual(
			checks.map((c) => c.id),
			[
				'project',
				'local-dev-server',
				'bb-data',
				'aws-credentials',
				'deployed-stack:production',
				'dashboard-writes',
			],
		);
	});

	it('names the project root, name and how it was resolved', () => {
		const check = byId(buildDoctorChecks(input({ projectVia: 'ancestor' })), 'project');
		assert.match(check.detail, /my-app/);
		assert.match(check.detail, /\/tmp\/my-app/);
		assert.match(check.detail, /ancestor/);
	});

	it('is pure — it does not mutate its input', () => {
		const original = input();
		const snapshot = JSON.parse(JSON.stringify(original));
		buildDoctorChecks(original);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(original)), snapshot);
	});
});

describe('buildDoctorChecks — local dev server', () => {
	it('warns rather than fails when the dev server is down, because it is optional', () => {
		const checks = buildDoctorChecks(
			input({ localDevServer: { ...healthyServer, serverUp: false, namespaces: [] } }),
		);
		const check = byId(checks, 'local-dev-server');
		assert.strictEqual(check.status, 'warn');
		assert.notStrictEqual(check.status, 'fail');
		assert.match(check.detail, /not running at http:\/\/localhost:3000/);
		assert.match(check.remediation ?? '', /npm run dev/);
		assertRemediationInvariant(checks);
	});

	it('reports the URL, port and discovered namespaces when up', () => {
		const check = byId(buildDoctorChecks(input()), 'local-dev-server');
		assert.match(check.detail, /running at http:\/\/localhost:3000/);
		assert.match(check.detail, /port 3000 from aws-blocks\/scripts\/server\.ts/);
		assert.match(check.detail, /api, admin/);
	});

	it('says so when the port was not discovered from server.ts', () => {
		const check = byId(
			buildDoctorChecks(input({ localDevServer: { ...healthyServer, portSource: 'default' } })),
			'local-dev-server',
		);
		assert.match(check.detail, /not discovered from aws-blocks\/scripts\/server\.ts/);
	});
});

describe('buildDoctorChecks — bb-data', () => {
	it('warns with the generate-data remediation when .bb-data is absent', () => {
		const checks = buildDoctorChecks(input({ localDevServer: { ...healthyServer, bbDataPresent: false } }));
		const check = byId(checks, 'bb-data');
		assert.strictEqual(check.status, 'warn');
		assert.strictEqual(check.remediation, 'run npm run dev to generate local data');
		assertRemediationInvariant(checks);
	});
});

describe('buildDoctorChecks — aws-credentials', () => {
	it('names the resolved profile, region and account when ok', () => {
		const check = byId(buildDoctorChecks(input()), 'aws-credentials');
		assert.strictEqual(check.status, 'ok');
		assert.match(check.detail, /profile dev/);
		assert.match(check.detail, /us-east-1/);
		assert.match(check.detail, /123456789012/);
	});

	it('says "ambient credential chain" when no named profile is in force', () => {
		const check = byId(buildDoctorChecks(input({ profile: undefined })), 'aws-credentials');
		assert.match(check.detail, /ambient credential chain/);
	});

	it('fails with an actionable remediation when credentials are missing', () => {
		const credentials: CredentialsProbe = {
			kind: 'error',
			code: 'CREDENTIALS_MISSING',
			message: 'Could not load credentials from any providers',
		};
		const checks = buildDoctorChecks(input({ credentials }));
		const check = byId(checks, 'aws-credentials');
		assert.strictEqual(check.status, 'fail');
		assert.match(check.remediation ?? '', /aws sso login|profile/);
		assertRemediationInvariant(checks);
	});

	it('fails with a refresh remediation when credentials are expired', () => {
		const credentials: CredentialsProbe = {
			kind: 'error',
			code: 'CREDENTIALS_EXPIRED',
			message: 'The security token included in the request is expired',
		};
		const check = byId(buildDoctorChecks(input({ credentials })), 'aws-credentials');
		assert.strictEqual(check.status, 'fail');
		assert.match(check.detail, /expired/);
		assert.match(check.remediation ?? '', /refresh/i);
	});

	it('translates a missing region into prose instead of raw SDK text', () => {
		const checks = buildDoctorChecks(input({ credentials: { kind: 'no-region' }, region: undefined }));
		const check = byId(checks, 'aws-credentials');
		assert.match(check.detail, /no AWS region configured/);
		assert.match(check.detail, /cloud mode needs one \(set AWS_REGION or pass --region\)/);
		assert.match(check.detail, /local mode needs no AWS at all/);
		assert.doesNotMatch(check.detail, /Region is missing/);
		assert.ok(check.remediation);
		assertRemediationInvariant(checks);
	});

	it('warns rather than blaming credentials for an unclassified probe failure', () => {
		const credentials: CredentialsProbe = { kind: 'error', code: 'UNKNOWN', message: 'socket hang up' };
		const check = byId(buildDoctorChecks(input({ credentials })), 'aws-credentials');
		assert.strictEqual(check.status, 'warn');
		assert.match(check.detail, /unrecognised reason/);
	});
});

describe('buildDoctorChecks — "nothing deployed" is NOT "could not look"', () => {
	const nothingDeployed: StackProbe = { kind: 'nothing-deployed', candidates: ['my-app-prod'] };
	const couldNotLook: StackProbe = {
		kind: 'could-not-look',
		reason: 'The security token included in the request is expired',
		credentialsAtFault: true,
	};

	it('credentials fine but nothing deployed: warn, and names the candidates searched', () => {
		const checks = buildDoctorChecks(
			input({ stacks: [{ stage: 'production', stackName: 'my-app-prod', probe: nothingDeployed }] }),
		);
		const check = byId(checks, 'deployed-stack:production');
		assert.strictEqual(check.status, 'warn');
		assert.match(check.detail, /nothing is deployed/);
		assert.match(check.detail, /AWS answered/);
		assert.match(check.detail, /my-app-prod/, 'the candidate stack names searched must be named');
		assertRemediationInvariant(checks);
	});

	it('could not look: fail, and points at the credentials check', () => {
		const checks = buildDoctorChecks({
			...input({ stacks: [{ stage: 'production', stackName: 'my-app-prod', probe: couldNotLook }] }),
			credentials: { kind: 'error', code: 'CREDENTIALS_EXPIRED', message: 'expired' },
		});
		const check = byId(checks, 'deployed-stack:production');
		assert.strictEqual(check.status, 'fail');
		assert.match(check.detail, /could not determine/);
		assert.match(check.remediation ?? '', /aws-credentials/);
		assertRemediationInvariant(checks);
	});

	// THE regression this whole report exists to prevent.
	it('renders the two outcomes differently — status, detail and remediation all differ', () => {
		const absent = byId(
			buildDoctorChecks(
				input({ stacks: [{ stage: 'production', stackName: 'my-app-prod', probe: nothingDeployed }] }),
			),
			'deployed-stack:production',
		);
		const blind = byId(
			buildDoctorChecks(
				input({ stacks: [{ stage: 'production', stackName: 'my-app-prod', probe: couldNotLook }] }),
			),
			'deployed-stack:production',
		);

		assert.notStrictEqual(absent.status, blind.status);
		assert.strictEqual(absent.status, 'warn');
		assert.strictEqual(blind.status, 'fail');
		assert.notStrictEqual(absent.detail, blind.detail);
		assert.notStrictEqual(absent.remediation, blind.remediation);

		// The blind case must never claim the account is empty...
		assert.doesNotMatch(blind.detail, /nothing is deployed/);
		assert.match(blind.detail, /not the same as nothing being deployed/);
		// ...and the deployed-nothing case must not blame credentials.
		assert.doesNotMatch(absent.remediation ?? '', /credential/i);
	});

	it('reports the stack as ok when it exists', () => {
		const checks = buildDoctorChecks(
			input({
				stacks: [
					{
						stage: 'production',
						stackName: 'my-app-prod',
						probe: { kind: 'deployed', stackName: 'my-app-prod', stackStatus: 'UPDATE_COMPLETE' },
					},
				],
			}),
		);
		const check = byId(checks, 'deployed-stack:production');
		assert.strictEqual(check.status, 'ok');
		assert.match(check.detail, /my-app-prod exists \(UPDATE_COMPLETE\)/);
	});

	it('emits one check per stage', () => {
		const checks = buildDoctorChecks(
			input({
				stackCandidates: ['my-app-prod', 'my-app-dev-jane'],
				stacks: [
					{ stage: 'production', stackName: 'my-app-prod', probe: nothingDeployed },
					{
						stage: 'sandbox',
						stackName: 'my-app-dev-jane',
						probe: { kind: 'deployed', stackName: 'my-app-dev-jane' },
					},
				],
			}),
		);
		assert.strictEqual(byId(checks, 'deployed-stack:production').status, 'warn');
		assert.strictEqual(byId(checks, 'deployed-stack:sandbox').status, 'ok');
	});

	it('warns without claiming anything when no candidate name could be resolved', () => {
		const checks = buildDoctorChecks(input({ stackCandidates: [], stacks: [] }));
		const check = byId(checks, 'deployed-stack');
		assert.strictEqual(check.status, 'warn');
		assert.match(check.detail, /no candidate stack name could be resolved/);
		assertRemediationInvariant(checks);
	});
});

describe('buildDoctorChecks — dashboard writes', () => {
	it('is informational and always ok', () => {
		const check = byId(buildDoctorChecks(input()), 'dashboard-writes');
		assert.strictEqual(check.status, 'ok');
		assert.match(check.detail, /locked by default/);
		assert.match(check.detail, /time-limited/);
	});
});

describe('labelStackCandidates', () => {
	it('maps candidate order onto stages: production first, sandbox second', () => {
		assert.deepStrictEqual(labelStackCandidates(['a-prod', 'a-dev-jane']), [
			{ stage: 'production', stackName: 'a-prod' },
			{ stage: 'sandbox', stackName: 'a-dev-jane' },
		]);
		assert.deepStrictEqual(labelStackCandidates([]), []);
	});
});

describe('runDoctor', () => {
	let tmpDir: string | undefined;
	const env = process.env as Record<string, string | undefined>;
	const savedEnv = {
		BLOCKS_DASHBOARD_PROFILE: env.BLOCKS_DASHBOARD_PROFILE,
		BLOCKS_DASHBOARD_REGION: env.BLOCKS_DASHBOARD_REGION,
		AWS_PROFILE: env.AWS_PROFILE,
		AWS_REGION: env.AWS_REGION,
		AWS_DEFAULT_REGION: env.AWS_DEFAULT_REGION,
	};

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	});

	function makeProject(): string {
		tmpDir = join(tmpdir(), `admin-ui-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tmpDir, '.blocks'), { recursive: true });
		writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'temp-doctor-app' }));
		writeFileSync(join(tmpDir, '.blocks', 'config.json'), JSON.stringify({ stackId: 'temp-doctor-app-abc' }));
		return tmpDir;
	}

	it('resolves rather than rejecting when the AWS path fails', async () => {
		const root = makeProject();
		const report = await runDoctor(
			{ projectRoot: root },
			{
				// Injected seams: a test must never touch a socket, loopback included.
				detectLocalDevServer: async () => ({
					serverUp: false,
					serverUrl: 'http://localhost:3000',
					port: 3000,
					portSource: 'default',
					namespaces: [],
					bbDataPresent: false,
				}),
				probeCredentials: () =>
					Promise.reject(new Error('the credentials probe blew up in a way doctor must survive')),
				probeStack: () => Promise.reject(new Error('never reached')),
			},
		);

		assert.strictEqual(report.projectRoot, root);
		assert.strictEqual(report.projectName, 'temp-doctor-app');
		assert.strictEqual(report.projectVia, 'explicit');
		assertRemediationInvariant(report.checks);
		// A thrown credentials probe must not become "nothing is deployed".
		const stack = byId(report.checks, 'deployed-stack:production');
		assert.strictEqual(stack.status, 'fail');
		assert.match(stack.detail, /not the same as nothing being deployed/);
	});

	it('honours a --profile / --region override before probing', async () => {
		const root = makeProject();
		const report = await runDoctor(
			{ projectRoot: root, profile: 'my-cli-profile', region: 'eu-west-1' },
			{
				detectLocalDevServer: async () => ({
					serverUp: false,
					serverUrl: 'http://localhost:3000',
					port: 3000,
					portSource: 'default',
					namespaces: [],
					bbDataPresent: false,
				}),
				probeCredentials: async () => ({ kind: 'ok', accountId: '123456789012' }),
				probeStack: async () => ({ kind: 'nothing-deployed', candidates: ['temp-doctor-app-abc-prod'] }),
			},
		);

		assert.strictEqual(report.awsContext?.profile, 'my-cli-profile');
		assert.strictEqual(report.awsContext?.region, 'eu-west-1');
		const credentials = byId(report.checks, 'aws-credentials');
		assert.match(credentials.detail, /my-cli-profile/);
		// Credentials worked, so an absent stack is reported as genuinely absent.
		assert.strictEqual(byId(report.checks, 'deployed-stack:production').status, 'warn');
	});

	it('never queries CloudFormation when credentials are broken', async () => {
		const root = makeProject();
		let stackProbeCalls = 0;
		const report = await runDoctor(
			{ projectRoot: root, region: 'eu-west-1' },
			{
				detectLocalDevServer: async () => ({
					serverUp: true,
					serverUrl: 'http://localhost:3000',
					port: 3000,
					portSource: 'default',
					namespaces: [],
					bbDataPresent: true,
				}),
				probeCredentials: async () => ({ kind: 'error', code: 'CREDENTIALS_EXPIRED', message: 'expired' }),
				probeStack: async () => {
					stackProbeCalls += 1;
					return { kind: 'nothing-deployed', candidates: ['x'] };
				},
			},
		);

		assert.strictEqual(stackProbeCalls, 0, 'a broken-credentials run must not ask CloudFormation anything');
		assert.strictEqual(byId(report.checks, 'aws-credentials').status, 'fail');
		assert.strictEqual(byId(report.checks, 'deployed-stack:production').status, 'fail');
	});
});
