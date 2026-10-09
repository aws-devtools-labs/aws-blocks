// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
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
import { buildSandboxDeployArgs } from './sandbox.js';

/**
 * Regression test (L68 (a)): sandbox telemetry always reported no blocks.
 * `startSandbox` filled the Scope BB registry by importing the CDK entry
 * (`index.cdk.ts`) in-process without `--conditions=cdk`; that import hit the
 * CDK guard, the error was swallowed, and no block ever registered. It now
 * gathers the registry the way `deploy()` does (FX55): from the aws-runtime
 * client-generation worker, before the deploy, so both the SUCCESS and the FAIL
 * events report the app's blocks.
 *
 * Runs the real `startSandbox({ deployOnly: true })` in a child process against
 * a fixture app, fully offline: no AWS region is set (the credential pre-check
 * is skipped), no connection string (no SSM), and `npm` on PATH is a fake that
 * records how it was called and writes the stack outputs a deploy would.
 */

const distScripts = dirname(fileURLToPath(import.meta.url));
const RUN_TIMEOUT_MS = 60_000;
const BACKEND_PATH = 'aws-blocks/index.cdk.ts';

interface SandboxRun {
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	telemetry: Array<{
		event: { command: string; state: string; error?: { code: string } };
		product: { buildingBlocks?: Array<{ name: string; version: string }> };
		counters?: { blocksCount: number };
	}>;
	npmCalls: Array<{ argv: string[]; nodeOptions: string | undefined; clientExisted: boolean }>;
	/** `.blocks-sandbox/config.json` and `aws-blocks/client.js` after the run, if written. */
	configJson?: string;
	clientJs?: string;
}

describe('startSandbox — telemetry reports the app’s blocks', () => {
	let tmp: string;
	let appDir: string;
	let success: SandboxRun;
	let failure: SandboxRun;

	const runSandbox = (name: string, failDeploy: boolean): SandboxRun => {
		rmSync(join(appDir, '.blocks-sandbox'), { recursive: true, force: true });
		rmSync(join(appDir, 'aws-blocks', 'client.js'), { force: true });
		const telemetryFile = join(tmp, `${name}-telemetry.json`);
		const npmLog = join(tmp, `${name}-npm.jsonl`);
		const env: NodeJS.ProcessEnv = {};
		// Only what's needed — in particular no AWS_* (region, profile, creds) and
		// no *_CONNECTION_STRING / *_DB_URL, so nothing can reach AWS.
		for (const key of ['HOME', 'TMPDIR', 'USER', 'LANG']) if (process.env[key]) env[key] = process.env[key];
		Object.assign(env, {
			PATH: [join(tmp, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
			NODE_OPTIONS: '',
			AWS_BLOCKS_DISABLE_TELEMETRY: '1',
			AWS_EC2_METADATA_DISABLED: 'true',
			AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
			FAKE_NPM_LOG: npmLog,
			FAKE_NPM_FAIL: failDeploy ? '1' : '',
			FX_CORE_COMMON_URL: pathToFileURL(join(distScripts, '..', 'common', 'index.js')).href,
		});
		const result = spawnSync(
			process.execPath,
			[join(tmp, 'run-sandbox.mjs'), `--telemetry-file=${telemetryFile}`],
			{
				cwd: appDir,
				env,
				encoding: 'utf-8',
				timeout: RUN_TIMEOUT_MS,
				killSignal: 'SIGKILL',
			},
		);
		const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, 'utf-8') : undefined);
		return {
			configJson: readIfExists(join(appDir, '.blocks-sandbox', 'config.json')),
			clientJs: readIfExists(join(appDir, 'aws-blocks', 'client.js')),
			status: result.status,
			signal: result.signal,
			stdout: String(result.stdout ?? ''),
			stderr: String(result.stderr ?? ''),
			telemetry: existsSync(telemetryFile) ? JSON.parse(readFileSync(telemetryFile, 'utf-8')) : [],
			npmCalls: existsSync(npmLog)
				? readFileSync(npmLog, 'utf-8')
						.trim()
						.split('\n')
						.map((l) => JSON.parse(l))
				: [],
		};
	};

	before(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), 'blocks-sandbox-telemetry-')));
		appDir = join(tmp, 'app');
		mkdirSync(join(appDir, 'aws-blocks'), { recursive: true });
		writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module' }));

		// A fake Building Block with conditional exports, like every real BB.
		const bb = join(appDir, 'node_modules', 'fake-bb');
		mkdirSync(bb, { recursive: true });
		writeFileSync(
			join(bb, 'package.json'),
			JSON.stringify({
				name: 'fake-bb',
				type: 'module',
				exports: {
					'.': { 'aws-runtime': './aws.mjs', default: './mock.mjs' },
					'./cdk': { cdk: './cdk.mjs', default: './cdk-guard.mjs' },
				},
			}),
		);
		const register = `const { Scope } = await import(process.env.FX_CORE_COMMON_URL);
new Scope('thing', { bbName: 'KVStore', bbVersion: '9.9.9' });`;
		writeFileSync(
			join(bb, 'mock.mjs'),
			`${register}\nconsole.log('FAKE_BB_MOCK_LOADED');\nsetInterval(() => {}, 1000);\n`,
		);
		writeFileSync(join(bb, 'aws.mjs'), `${register}\n`);
		// The CDK entry refuses to load without `--conditions=cdk`, like `@aws-blocks/*/cdk`.
		writeFileSync(join(bb, 'cdk-guard.mjs'), `throw new Error('run with --conditions=cdk');\n`);
		writeFileSync(join(bb, 'cdk.mjs'), `${register}\n`);
		// The client-generation worker runs `node --import tsx` from the app directory.
		symlinkSync(
			dirname(fileURLToPath(import.meta.resolve('tsx/package.json'))),
			join(appDir, 'node_modules', 'tsx'),
		);

		writeFileSync(
			join(appDir, 'aws-blocks', 'index.ts'),
			`import 'fake-bb';\nexport const api = { hello: async () => 'hi' };\n`,
		);
		writeFileSync(join(appDir, BACKEND_PATH), `import 'fake-bb/cdk';\nimport './index.js';\n`);

		// A fake `npm`: records each call, then fails or writes the outputs a deploy writes.
		mkdirSync(join(tmp, 'bin'));
		writeFileSync(
			join(tmp, 'fake-npm.mjs'),
			`import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ argv, nodeOptions: process.env.NODE_OPTIONS, clientExisted: existsSync('aws-blocks/client.js') }) + '\\n');
if (process.env.FAKE_NPM_FAIL) process.exit(1);
const outputs = argv[argv.indexOf('--outputs-file') + 1];
mkdirSync(dirname(outputs), { recursive: true });
writeFileSync(outputs, JSON.stringify({ 'fixture-stack': { ApiUrl: 'https://fake-api.example.com/' } }));
`,
		);
		writeFileSync(join(tmp, 'bin', 'npm'), `#!/bin/sh\nexec node "${join(tmp, 'fake-npm.mjs')}" "$@"\n`);
		chmodSync(join(tmp, 'bin', 'npm'), 0o755);

		writeFileSync(
			join(tmp, 'run-sandbox.mjs'),
			`import { startSandbox } from ${JSON.stringify(pathToFileURL(join(distScripts, 'sandbox.js')).href)};
try {
	const apiUrl = await startSandbox({ backendPath: ${JSON.stringify(BACKEND_PATH)}, deployOnly: true });
	console.log('RETURNED ' + apiUrl);
} catch (e) {
	console.log('THREW ' + e.message);
}
`,
		);

		success = runSandbox('success', false);
		failure = runSandbox('failure', true);
	});

	after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('the deploy-only sandbox run finishes and exits on its own', () => {
		assert.strictEqual(
			success.signal,
			null,
			`still running after ${RUN_TIMEOUT_MS}ms:\n${success.stdout}\n${success.stderr}`,
		);
		assert.strictEqual(success.status, 0, success.stderr);
		assert.match(success.stdout, /RETURNED https:\/\/fake-api\.example\.com\//);
	});

	it('the SUCCESS event reports the app’s blocks', () => {
		assert.strictEqual(success.telemetry.length, 1, success.stdout);
		const [event] = success.telemetry;
		assert.deepStrictEqual(event.event.command, 'sandbox');
		assert.deepStrictEqual(event.event.state, 'SUCCESS');
		assert.deepStrictEqual(event.product.buildingBlocks, [{ name: 'KVStore', version: '9.9.9' }]);
		assert.strictEqual(event.counters?.blocksCount, 1);
	});

	it('the FAIL event of a failed deploy reports the app’s blocks too', () => {
		assert.match(failure.stdout, /THREW npm .* exited with code 1/);
		assert.strictEqual(failure.telemetry.length, 1, failure.stdout);
		const [event] = failure.telemetry;
		assert.deepStrictEqual(event.event.state, 'FAIL');
		assert.deepStrictEqual(event.event.error, { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' });
		assert.deepStrictEqual(event.product.buildingBlocks, [{ name: 'KVStore', version: '9.9.9' }]);
	});

	it('deploys exactly as before: one `cdk deploy` with the same argv and `--conditions=cdk`', () => {
		assert.strictEqual(success.npmCalls.length, 1);
		const [call] = success.npmCalls;
		assert.deepStrictEqual(
			call.argv,
			buildSandboxDeployArgs({ outDir: '.blocks-sandbox', projectRoot: appDir, backendPath: BACKEND_PATH }),
		);
		assert.strictEqual(call.nodeOptions, '--conditions=cdk');
	});

	it('writes the same outputs: config.json and the aws-runtime client (generated before the deploy)', () => {
		assert.strictEqual(success.npmCalls[0].clientExisted, true);
		assert.ok(success.configJson, 'config.json was not written');
		assert.deepStrictEqual(JSON.parse(success.configJson), {
			apiUrl: 'https://fake-api.example.com/',
			environment: 'sandbox',
		});
		assert.match(success.clientJs ?? '', /export const api = /);
		assert.match(success.stdout, /BLOCKS_DEPLOYED api=https:\/\/fake-api\.example\.com\//);
	});

	it("never loads a Building Block's local mock layer", () => {
		assert.ok(!success.stdout.includes('FAKE_BB_MOCK_LOADED'), success.stdout);
		assert.ok(!failure.stdout.includes('FAKE_BB_MOCK_LOADED'), failure.stdout);
	});
});
