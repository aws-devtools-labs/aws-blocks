// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CredentialFailureInText } from './credential-guidance.js';
import type { OutputSink } from './deploy-stream.js';
import {
	createSandboxDeployObserver,
	relayCdkWatchOutput,
	sandboxCredentialFailureMessage,
	sandboxDenialRecoveryHint,
	sandboxFailureRecoveryHint,
} from './sandbox.js';

// CDK CLI output of a sandbox deploy (`--method direct --express`, no `--ci`, so
// everything is on stderr) that an SCP stopped at `cloudformation:CreateStack`,
// with identifiers replaced by documented example values.
const STACK = 'my-app-a1b2c3-user-x1y2z3';
const DEPLOY_ROLE =
	'arn:aws:sts::123456789012:assumed-role/cdk-hnb659fds-deploy-role-123456789012-us-east-1/aws-cdk-user';
const SCP_ARN = 'arn:aws:organizations::777788889999:policy/o-exampleorgid/service_control_policy/p-examplepolicyid123';
const CREATE_STACK_DENIED = [
	`${STACK}: deploying... [1/1]`,
	// The CDK CLI prints the stack name in bold in a terminal.
	`\u001b[1m${STACK}\u001b[22m: creating stack...`,
	`❌  ${STACK} failed to deploy`,
	`‣ AccessDenied: User: ${DEPLOY_ROLE} is not authorized to perform: cloudformation:CreateStack on resource: arn:aws:cloudformation:us-east-1:123456789012:stack/${STACK}/* with an explicit deny in a service control policy: ${SCP_ARN}`,
	'',
];
const event = (status: string, type: string, id: string, reason = ''): string =>
	`${STACK} | 0/3 | 10:00:01 AM | ${status.padEnd(23)} | ${type.padEnd(36)} | ${id} ${reason}`;
const UPDATE_FAILED = [
	`${STACK}: deploying... [1/1]`,
	`${STACK}: updating stack...`,
	event('UPDATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
	event(
		'UPDATE_FAILED',
		'AWS::Lambda::Function',
		'Handler (Handler886CB40B)',
		'Resource handler returned message: "Unzipped size must be smaller than 262144000 bytes (Service: Lambda, Status Code: 400)"',
	),
	event(
		'UPDATE_FAILED',
		'AWS::CloudFormation::Stack',
		STACK,
		'The following resource(s) failed to update: [Handler886CB40B]',
	),
	`❌  ${STACK} failed to deploy`,
	'‣ DeploymentError: Resource updates failed:',
	'',
];
const UPDATE_DENIED = [
	`${STACK}: deploying... [1/1]`,
	`${STACK}: updating stack...`,
	event('UPDATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
	event(
		'CREATE_FAILED',
		'AWS::SQS::Queue',
		'Jobs (JobsQueue1A2B3C4D)',
		`Resource handler returned message: "User: ${DEPLOY_ROLE} is not authorized to perform: sqs:createqueue with an explicit deny in a service control policy"`,
	),
	event(
		'UPDATE_FAILED',
		'AWS::CloudFormation::Stack',
		STACK,
		'The following resource(s) failed to create: [JobsQueue1A2B3C4D]',
	),
	`❌  ${STACK} failed to deploy`,
	'',
];
const CREATE_FAILED = [
	`${STACK}: deploying... [1/1]`,
	`${STACK}: creating stack...`,
	event('CREATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
	event(
		'CREATE_FAILED',
		'AWS::S3::Bucket',
		'Assets (Assets1A2B3C4D)',
		'Resource handler returned message: "my-app-assets already exists (Service: S3, Status Code: 409)"',
	),
	event(
		'CREATE_FAILED',
		'AWS::CloudFormation::Stack',
		STACK,
		'The following resource(s) failed to create: [Assets1A2B3C4D]',
	),
	`❌  ${STACK} failed to deploy`,
	'',
];

function collectingSink(): OutputSink & { text(): string } {
	const chunks: string[] = [];
	return {
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		text: () => chunks.join(''),
	};
}

describe('createSandboxDeployObserver — the initial sandbox deploy’s stderr', () => {
	it('relays every chunk unchanged and adds the notice after the line that showed the deny', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		const text = CREATE_STACK_DENIED.join('\r\n');
		const denyAt = text.indexOf('with an explicit deny');
		// Split inside the explicit-deny phrase and again inside the next line.
		for (const chunk of [text.slice(0, denyAt + 10), text.slice(denyAt + 10, -1), text.slice(-1)]) {
			observer.write(chunk);
		}
		observer.end();
		const relayed = out.text();
		const noticeAt = relayed.indexOf('⚠️  AWS denied a request during `npm run sandbox`');
		assert.ok(noticeAt > 0, relayed);
		// Everything the CDK CLI wrote is there, byte for byte, with the notice
		// inserted right after the line that ends the evidence.
		const evidenceEnd = text.indexOf('\n', denyAt) + 1;
		assert.strictEqual(relayed.slice(0, noticeAt), text.slice(0, evidenceEnd));
		assert.ok(relayed.endsWith(text.slice(evidenceEnd)), relayed);
		assert.match(relayed, /Signing in again or adding IAM permissions does not change that/);
		assert.doesNotMatch(relayed.slice(noticeAt), /123456789012|o-exampleorgid|p-examplepolicyid123/);
		assert.strictEqual(observer.denied(), true);
	});

	it('reads a trailing line without a newline when the stream ends', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		observer.write(CREATE_STACK_DENIED.slice(0, 4).join('\n'));
		assert.strictEqual(observer.denied(), false);
		observer.end();
		assert.strictEqual(observer.denied(), true);
		assert.match(out.text(), /\/\*\swith an explicit deny[^\n]*\n⚠️ {2}AWS denied a request/);
	});

	it('passes progress and terminal control sequences through untouched and adds nothing on success', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		const progress = `\u001b[1m${STACK}\u001b[22m: deploying... [1/1]\n${event('CREATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK)}\r\n\u001b[2K partial`;
		observer.write(progress);
		observer.end();
		assert.strictEqual(out.text(), progress);
		assert.strictEqual(observer.denied(), false);
	});

	it('explains a denial without policy evidence once the deploy fails', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		observer.write(
			`${event('CREATE_FAILED', 'AWS::KMS::Key', 'Key', `Resource handler returned message: "Access denied for operation 'CreateKey'."`)}\n`,
		);
		assert.strictEqual(observer.denied(), false);
		observer.end();
		observer.failed();
		assert.strictEqual(observer.denied(), true);
		assert.match(out.text(), /The credentials do not have the permissions/);
	});
});

describe('sandbox failure recovery — the Express Mode note only without a denial', () => {
	it('keeps the Express Mode recovery exactly as it was', () => {
		assert.strictEqual(
			sandboxFailureRecoveryHint(),
			[
				'',
				'ℹ️  Express Mode leaves failed sandbox stacks in place (automatic rollback is off).',
				'   If the next `npm run sandbox` reports the stack cannot be updated, recover with:',
				'',
				'     npm run sandbox:destroy   # tears the failed stack down (handles ROLLBACK_COMPLETE)',
				'     npm run sandbox           # redeploy from a clean slate',
				'',
				'   If destroy reports UPDATE_ROLLBACK_FAILED, first run:',
				'     aws cloudformation continue-update-rollback --stack-name <your-sandbox-stack>',
			].join('\n'),
		);
	});

	it('after a denial, limits destroy to a first deploy and keeps an existing sandbox', () => {
		const hint = sandboxDenialRecoveryHint();
		assert.match(hint, /first deploy of this sandbox[^\n]*holds no data[^\n]*`npm run sandbox:destroy` removes it/);
		assert.match(hint, /existed before, do not destroy it \(that deletes its data\)[^\n]*`npm run sandbox` again/);
		assert.doesNotMatch(hint, /Express Mode|limit|budget|spend|\d{12}|arn:/i);
	});
});

describe('relayCdkWatchOutput — `cdk watch` output', () => {
	/** A `cdk watch` output stream that delivers each write as one chunk, synchronously. */
	class FakeStream extends EventEmitter {
		setEncoding(): this {
			return this;
		}
		write(chunk: string): void {
			this.emit('data', chunk);
		}
		end(): void {
			this.emit('end');
		}
	}
	const watch = () => {
		const stdout = new FakeStream();
		const stderr = new FakeStream();
		const logs: string[] = [];
		const errors: string[] = [];
		const relay = relayCdkWatchOutput(
			{ stdout, stderr },
			{ log: (t) => logs.push(t), error: (t) => errors.push(t) },
			async (failure: CredentialFailureInText) => `CREDENTIALS ${failure.errorName} ${failure.failure}`,
		);
		const notices = () => errors.filter((e) => e.startsWith('⚠️  AWS denied')).length;
		const credentials = () => errors.filter((e) => e.startsWith('CREDENTIALS'));
		return { stdout, stderr, logs, errors, notices, credentials, relay };
	};
	const DENY = `‣ AccessDenied: User: ${DEPLOY_ROLE} is not authorized to perform: lambda:CreateFunction with an explicit deny in a service control policy`;

	it('relays output as before and explains a deny split across chunks', () => {
		const w = watch();
		w.stdout.write('[START RequestId: 1a2b] noise\n');
		w.stdout.write('watch: deploying\n');
		w.stderr.write("Triggering initial 'cdk deploy'\n");
		w.stderr.write(`❌  ${STACK} failed to deploy\n${DENY.slice(0, 80)}`);
		assert.strictEqual(w.notices(), 0);
		w.stderr.write(`${DENY.slice(80)}\r\n`);
		assert.deepStrictEqual(w.logs, ['[CDK Watch] watch: deploying'], 'Lambda request markers stay filtered');
		assert.strictEqual(w.errors[0], "[CDK Watch] Triggering initial 'cdk deploy'");
		assert.strictEqual(w.notices(), 1);
		assert.match(w.errors.at(-1) ?? '', /AWS Organizations policy/);
	});

	it('reads denial evidence on stdout too, with colors', () => {
		const w = watch();
		w.stdout.write(
			`\u001b[31m${event('CREATE_FAILED', 'AWS::SQS::Queue', 'Jobs', `"User: x is not authorized to perform: sqs:createqueue with an explicit deny in a resource control policy"`)}\u001b[39m\n`,
		);
		assert.strictEqual(w.notices(), 1);
	});

	it('explains repeated errors once per deployment, and again for the next deployment', () => {
		const w = watch();
		const failure = `❌  ${STACK} failed to deploy\n${DENY}\n\n`;
		w.stderr.write(`Triggering initial 'cdk deploy'\n${failure}${failure}`);
		w.stderr.write(failure);
		assert.strictEqual(w.notices(), 1);
		w.stderr.write(
			`Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n${failure}${failure}`,
		);
		assert.strictEqual(w.notices(), 2);
	});

	it('adds nothing for an ordinary failure during watch', async () => {
		const w = watch();
		w.stderr.write(`Triggering initial 'cdk deploy'\n${UPDATE_FAILED.join('\n')}`);
		w.stderr.end();
		await w.relay.idle();
		assert.strictEqual(w.notices(), 0);
		assert.deepStrictEqual(w.credentials(), []);
	});

	it('explains a credential failure in watch once per deployment, and never as a denial', async () => {
		const w = watch();
		w.stderr.write("Triggering initial 'cdk deploy'\n");
		// cdk watch prints a failed asset upload; a deploy error block is not printed in watch.
		w.stderr.write(`${STACK}: fail: The security token included in the request is expired\n`);
		w.stderr.write(`${STACK}: fail: Assuming role failed: ExpiredToken\n`);
		await w.relay.idle();
		assert.deepStrictEqual(w.credentials(), ['CREDENTIALS ExpiredToken expired'], 'once per deployment');
		assert.strictEqual(w.notices(), 0, 'an expired token is not a denial');
		assert.ok(
			w.errors.some((e) => e.includes('fail: The security token')),
			'the CDK output is still relayed',
		);
		w.stderr.write("Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n");
		w.stderr.write(
			`${STACK}: fail: The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.\n`,
		);
		await w.relay.idle();
		assert.deepStrictEqual(w.credentials(), [
			'CREDENTIALS ExpiredToken expired',
			'CREDENTIALS CredentialsProviderError expired',
		]);
		// A deny in the next deployment is still explained, without credential guidance.
		w.stderr.write(`Detected change to 'aws-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n${DENY}\n`);
		await w.relay.idle();
		assert.strictEqual(w.notices(), 1);
		assert.strictEqual(w.credentials().length, 2);
	});

	it('ignores credential wording in app logs', async () => {
		const w = watch();
		w.stderr.write("Triggering initial 'cdk deploy'\n");
		w.stdout.write(
			'[/aws/lambda/handler] 10:00:00 AM ExpiredTokenException: The security token included in the request is expired\n',
		);
		await w.relay.idle();
		assert.deepStrictEqual(w.credentials(), []);
	});
});

describe('sandboxCredentialFailureMessage — source-aware sign-in guidance', () => {
	const withConfig = async (config: string, env: NodeJS.ProcessEnv, watching: boolean) => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-credentials-'));
		try {
			writeFileSync(join(dir, 'config'), config);
			writeFileSync(join(dir, 'credentials'), '');
			return await sandboxCredentialFailureMessage(
				{ errorName: 'ExpiredToken', failure: 'expired' },
				{
					watching,
					projectRoot: dir,
					env: {
						AWS_CONFIG_FILE: join(dir, 'config'),
						AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
						HOME: dir,
						...env,
					},
					readAwsCliVersion: async () => 'aws-cli/2.33.0 Python/3.12',
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const noIds = (message: string) => assert.doesNotMatch(message, /\d{12}|arn:|AKIA|secret-example/);

	it('tells an aws login profile to sign in again, then to save a file while watching', async () => {
		const message = await withConfig(
			'[profile dev]\nlogin_session = arn:aws:iam::123456789012:user/example\nregion = us-east-1\n',
			{ AWS_PROFILE: 'dev' },
			true,
		);
		assert.match(message, /aws login --profile dev/);
		assert.match(message, /save a file/);
		assert.doesNotMatch(message, /re-run `npm run sandbox`/);
		noIds(message);
	});

	const staticKeys = 'aws_access_key_id = AKIAEXAMPLEKEYID0000\naws_secret_access_key = secret-example\n';
	const restart = /stop `npm run sandbox`[^\n]*run it again/;

	it('lets a role profile pick up new credentials on the next saved file', async () => {
		const message = await withConfig(
			`[profile dev]\nrole_arn = arn:aws:iam::123456789012:role/Deployer\nsource_profile = base\nregion = us-east-1\n[profile base]\n${staticKeys}`,
			{ AWS_PROFILE: 'dev' },
			true,
		);
		assert.match(message, /save a file/);
		assert.doesNotMatch(message, restart);
		noIds(message);
	});

	it('asks to restart the watch for direct profile keys and for credential_process', async () => {
		for (const profile of [staticKeys, 'credential_process = /usr/local/bin/print-credentials\n']) {
			const message = await withConfig(
				`[profile dev]\n${profile}region = us-east-1\n`,
				{ AWS_PROFILE: 'dev' },
				true,
			);
			assert.match(message, restart);
			noIds(message);
		}
	});

	it('tells an IAM Identity Center profile to run aws sso login', async () => {
		const message = await withConfig(
			'[profile dev]\nsso_session = corp\nsso_account_id = 123456789012\nsso_role_name = Developer\nregion = us-east-1\n',
			{ AWS_PROFILE: 'dev' },
			true,
		);
		assert.match(message, /aws sso login --profile dev/);
		noIds(message);
	});

	it('tells environment keys to export new ones and restart, which a running watch needs', async () => {
		const env = {
			AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID0000',
			AWS_SECRET_ACCESS_KEY: 'secret-example',
			AWS_REGION: 'us-east-1',
		};
		const watching = await withConfig('', env, true);
		assert.match(watching, /temporary credentials in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY have expired/);
		assert.match(watching, /stop `npm run sandbox`[^\n]*run it again/);
		noIds(watching);
		// Outside watch (the initial deploy), the command has stopped: re-run it.
		assert.match(await withConfig('', env, false), /Then re-run `npm run sandbox`\.$/);
	});
});

/**
 * The real `startSandbox({ deployOnly: true })` in a child process, offline, with
 * a fake `npm` that prints what the CDK CLI prints (see sandbox-telemetry.test.ts
 * for the fixture's design). The fake deploy writes its stderr in two chunks, in
 * the middle of a line, and records which stdin and stdout it was given.
 */
describe('startSandbox — the initial deploy’s output and failure guidance', () => {
	const distScripts = dirname(fileURLToPath(import.meta.url));
	const BACKEND_PATH = 'aws-blocks/index.cdk.ts';
	let tmp: string;
	let appDir: string;

	const runSandbox = (
		stderrLines: string[],
		exitCode: number,
		stdoutLines = ['result from cdk on stdout'],
		extraEnv: NodeJS.ProcessEnv = {},
	) => {
		rmSync(join(appDir, '.blocks-sandbox'), { recursive: true, force: true });
		const name = `run-${Math.random().toString(36).slice(2)}`;
		const telemetryFile = join(tmp, `${name}-telemetry.json`);
		const env: NodeJS.ProcessEnv = {};
		for (const key of ['TMPDIR', 'USER', 'LANG']) if (process.env[key]) env[key] = process.env[key];
		Object.assign(env, {
			PATH: [join(tmp, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
			NODE_OPTIONS: '',
			HOME: join(tmp, 'home'),
			BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
			AWS_EC2_METADATA_DISABLED: 'true',
			AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
			FAKE_CDK_STDERR: stderrLines.join('\n'),
			FAKE_CDK_STDOUT: stdoutLines.map((line) => `${line}\n`).join(''),
			FAKE_CDK_EXIT: String(exitCode),
			FAKE_FDS: join(tmp, `${name}-fds.json`),
			...extraEnv,
		});
		const result = spawnSync(
			process.execPath,
			[join(tmp, 'run-sandbox.mjs'), `--telemetry-file=${telemetryFile}`],
			{
				cwd: appDir,
				env,
				encoding: 'utf-8',
				timeout: 60_000,
				killSignal: 'SIGKILL',
			},
		);
		const readJson = (path: string) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : undefined);
		const fdsFile = join(tmp, `${name}-fds.json`);
		return {
			status: result.status,
			stdout: String(result.stdout ?? ''),
			stderr: String(result.stderr ?? ''),
			fds: readJson(fdsFile),
			parentFds: readJson(`${fdsFile}.parent`),
			telemetry: existsSync(telemetryFile) ? JSON.parse(readFileSync(telemetryFile, 'utf-8')) : [],
		};
	};

	before(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), 'blocks-sandbox-denial-')));
		appDir = join(tmp, 'app');
		mkdirSync(join(appDir, 'aws-blocks'), { recursive: true });
		mkdirSync(join(tmp, 'home'), { recursive: true });
		writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module' }));
		mkdirSync(join(appDir, 'node_modules'));
		symlinkSync(
			dirname(fileURLToPath(import.meta.resolve('tsx/package.json'))),
			join(appDir, 'node_modules', 'tsx'),
		);
		writeFileSync(join(appDir, 'aws-blocks', 'index.ts'), `export const api = { hello: async () => 'hi' };\n`);
		writeFileSync(join(appDir, BACKEND_PATH), `import './index.js';\n`);

		mkdirSync(join(tmp, 'bin'));
		writeFileSync(
			join(tmp, 'fake-npm.mjs'),
			`import { fstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const argv = process.argv.slice(2);
if (argv[3] !== 'deploy') process.exit(0); // cdk synth
const id = (fd) => { const s = fstatSync(fd); return s.dev + ':' + s.ino; };
writeFileSync(process.env.FAKE_FDS, JSON.stringify({ stdin: id(0), stdout: id(1) }));
process.stdout.write(process.env.FAKE_CDK_STDOUT);
const text = process.env.FAKE_CDK_STDERR;
const cut = Math.floor(text.length / 2);
process.stderr.write(text.slice(0, cut));
// A real pause in the child, so that the parent reads two separate chunks.
setTimeout(() => {
  process.stderr.write(text.slice(cut));
  const code = Number(process.env.FAKE_CDK_EXIT);
  if (code === 0) {
    const outputs = argv[argv.indexOf('--outputs-file') + 1];
    mkdirSync(dirname(outputs), { recursive: true });
    writeFileSync(outputs, JSON.stringify({ 'fixture-stack': { ApiUrl: 'https://fake-api.example.com/' } }));
  }
  process.exitCode = code;
}, 50);
`,
		);
		writeFileSync(join(tmp, 'bin', 'npm'), `#!/bin/sh\nexec node "${join(tmp, 'fake-npm.mjs')}" "$@"\n`);
		chmodSync(join(tmp, 'bin', 'npm'), 0o755);
		writeFileSync(
			join(tmp, 'run-sandbox.mjs'),
			`import { fstatSync, writeFileSync } from 'node:fs';
import { startSandbox } from ${JSON.stringify(pathToFileURL(join(distScripts, 'sandbox.js')).href)};
const id = (fd) => { const s = fstatSync(fd); return s.dev + ':' + s.ino; };
writeFileSync(process.env.FAKE_FDS + '.parent', JSON.stringify({ stdin: id(0), stdout: id(1) }));
try {
	const apiUrl = await startSandbox({ backendPath: ${JSON.stringify(BACKEND_PATH)}, deployOnly: true });
	console.log('RETURNED ' + apiUrl);
} catch (e) {
	console.log('THREW ' + e.message);
}
`,
		);
	});

	after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	const DENIAL_RECOVERY = 'If this was the first deploy of this sandbox';

	it('explains a CreateStack deny, replaces the Express Mode note and keeps the failure as it was', {
		timeout: 90_000,
	}, () => {
		const run = runSandbox(CREATE_STACK_DENIED, 1);
		const evidence = CREATE_STACK_DENIED[3];
		const at = (needle: string) => run.stderr.indexOf(needle);
		assert.ok(at(evidence) >= 0, run.stderr);
		assert.ok(at('⚠️  AWS denied a request during `npm run sandbox`') > at(evidence), run.stderr);
		assert.ok(at('❌ Deployment failed.') > at('AWS denied a request'), 'the explanation comes before the verdict');
		assert.ok(at(DENIAL_RECOVERY) > at('❌ Deployment failed.'), run.stderr);
		assert.doesNotMatch(run.stderr, /Express Mode leaves/);
		// Same error, exit and telemetry as before.
		assert.match(run.stdout, /THREW npm exec cdk -- deploy .* exited with code 1/);
		assert.deepStrictEqual(
			run.telemetry.map((e: { event: { state: string; error?: unknown } }) => [e.event.state, e.event.error]),
			[['FAIL', { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' }]],
		);
	});

	it('gives a denied update the same fixed recovery, and an ordinary failure the Express Mode note', {
		timeout: 90_000,
	}, () => {
		const denied = runSandbox(UPDATE_DENIED, 1);
		assert.match(
			denied.stderr,
			/AWS denied a request[\s\S]*❌ Deployment failed\.\n\nℹ️ {2}If this was the first deploy/,
		);
		assert.doesNotMatch(denied.stderr, /Express Mode leaves/);
		// A stack whose name contains AccessDenied (stackId `AccessDenied`) is not a denial.
		const namedAccessDenied = [
			'AccessDenied-prod: deploying... [1/1]',
			'AccessDenied-prod: creating stack...',
			'AccessDenied-prod | 0/3 | 10:00:01 AM | CREATE_FAILED           | AWS::CloudFormation::Stack           | AccessDenied-prod The following resource(s) failed to create: [Assets1A2B3C4D]',
			'❌  AccessDenied-prod failed to deploy',
			'‣ ValidationError: Template format error: Unrecognized resource types: [AWS::Example::Thing]',
			'',
		];
		for (const lines of [UPDATE_FAILED, CREATE_FAILED, namedAccessDenied]) {
			const ordinary = runSandbox(lines, 1);
			assert.doesNotMatch(ordinary.stderr, /AWS denied a request/);
			assert.ok(
				ordinary.stderr.includes(`❌ Deployment failed.\n${sandboxFailureRecoveryHint()}\n`),
				ordinary.stderr,
			);
		}
	});

	it('explains a credential failure of the initial deploy for its source, before the verdict', {
		timeout: 90_000,
	}, () => {
		const run = runSandbox(
			[
				`❌  ${STACK} failed to deploy`,
				'‣ ExpiredToken: The security token included in the request is expired',
				'',
			],
			1,
			undefined,
			// Environment keys, and no Region, so the pre-deploy check is skipped as in the other runs.
			{ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID0000', AWS_SECRET_ACCESS_KEY: 'secret-example' },
		);
		const at = (needle: string) => run.stderr.indexOf(needle);
		assert.ok(at('AWS credentials could not be verified for `npm run sandbox` (ExpiredToken).') > 0, run.stderr);
		assert.match(run.stderr, /temporary credentials in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY have expired/);
		assert.ok(at('Then re-run `npm run sandbox`.') < at('❌ Deployment failed.'), run.stderr);
		assert.doesNotMatch(run.stderr, /AWS denied a request/);
		assert.ok(run.stderr.includes(`❌ Deployment failed.\n${sandboxFailureRecoveryHint()}\n`), run.stderr);
		assert.doesNotMatch(run.stderr.slice(at('AWS credentials could not be verified')), /AKIA|secret-example/);
	});

	it('in CI mode (events on stdout), explains the deny once from the error block on stderr', {
		timeout: 90_000,
	}, () => {
		// With CI set, the CDK CLI prints its progress to stdout, which stays inherited
		// and is not read; its error block still goes to stderr.
		const deniedEvent = event(
			'CREATE_FAILED',
			'AWS::ApiGateway::RestApi',
			'DefaultCompute/API (DefaultComputeAPI5E5CE44A)',
			`Resource handler returned message: "User: ${DEPLOY_ROLE} is not authorized to perform: apigateway:POST with an explicit deny in a service control policy"`,
		);
		const errorBlock = [
			`❌  ${STACK} failed to deploy`,
			'‣ DeploymentError: Resource updates failed:',
			`${STACK}/DefaultCompute/API/Resource  (AWS::ApiGateway::RestApi DefaultComputeAPI5E5CE44A)`,
			'  Resource handler returned message: "User:',
			`  ${DEPLOY_ROLE} is not`,
			'  authorized to perform: apigateway:POST on resource: arn:aws:apigateway:us-east-1::/restapis with an explicit deny in a',
			`  service control policy: ${SCP_ARN}`,
			'  (Service: ApiGateway, Status Code: 403)"',
			'',
		];
		const run = runSandbox(errorBlock, 1, [`${STACK}: creating stack...`, deniedEvent, deniedEvent]);
		assert.ok(run.stdout.includes(deniedEvent), 'the events reach stdout unchanged');
		assert.doesNotMatch(run.stdout, /AWS denied a request/);
		assert.strictEqual(run.stderr.split('AWS denied a request').length - 1, 1, run.stderr);
		assert.ok(
			run.stderr.indexOf('AWS denied a request') > run.stderr.indexOf('  service control policy:'),
			run.stderr,
		);
		assert.match(run.stderr, /❌ Deployment failed\.\n\nℹ️ {2}If this was the first deploy/);
		assert.doesNotMatch(run.stderr, /Express Mode leaves/);
	});

	it('streams the deploy output unchanged, keeps the terminal on stdin and stdout, and succeeds as before', {
		timeout: 90_000,
	}, () => {
		const progress = [
			`${STACK}: deploying... [1/1]`,
			`${STACK}: creating stack...`,
			event('CREATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
			event('CREATE_COMPLETE', 'AWS::CloudFormation::Stack', STACK),
			'',
			` ✅  ${STACK}`,
		];
		const run = runSandbox(progress, 0);
		assert.strictEqual(run.status, 0, run.stderr);
		assert.ok(run.stderr.includes(progress.join('\n')), run.stderr);
		assert.doesNotMatch(run.stderr, /AWS denied|Deployment failed/);
		assert.match(
			run.stdout,
			/result from cdk on stdout[\s\S]*BLOCKS_DEPLOYED api=https:\/\/fake-api\.example\.com\//,
		);
		// The deploy gets this process's own stdin and stdout, so the CDK CLI sees the
		// same terminal (colors, progress display) as before; only stderr is read.
		assert.ok(run.fds, 'the fake deploy ran');
		assert.deepStrictEqual(run.fds, run.parentFds);
	});
});
