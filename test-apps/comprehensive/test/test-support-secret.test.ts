// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The e2e harness runs under `tsx -C browser`. There the AWS SDK resolves its
 * browser build, and `new SSMClient()` throws `(0 , client_1.
 * emitWarningIfUnsupportedVersion) is not a function` — which failed every
 * sandbox suite that needed the test-support secret (FX52). The harness now
 * reads the secret in a clean subprocess (`read-test-support-secret.ts`).
 *
 * Offline proof: each case runs `test-support-secret.probe.ts` under
 * `tsx -C browser`, like the harness, against a stub SSM on localhost
 * (`AWS_ENDPOINT_URL_SSM`, dummy credentials), so no AWS call is made.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PARAMETER_NAME = '/blocks/test-app/test-support-secret-stub';
const STUB_SECRET = `stub-secret-${process.pid}-${Date.now().toString(36)}`;
const LOCAL_SECRET = `local-secret-${process.pid}`;

interface StubRequest {
	target: string | undefined;
	body: { Name?: string; WithDecryption?: boolean };
}

interface ProbeResult {
	ok: boolean;
	secret?: string;
	name?: string;
	message?: string;
}

let server: Server;
let endpoint: string;
const requests: StubRequest[] = [];

/** A stand-in for SSM's `GetParameter` (AWS JSON 1.1 protocol). */
function startStub(): Promise<void> {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => {
			raw += chunk.toString();
		});
		req.on('end', () => {
			const target = req.headers['x-amz-target'];
			requests.push({ target: typeof target === 'string' ? target : undefined, body: JSON.parse(raw || '{}') });
			res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.1' });
			res.end(
				JSON.stringify({
					Parameter: { Name: PARAMETER_NAME, Type: 'SecureString', Value: STUB_SECRET, Version: 1 },
				}),
			);
		});
	});
	return new Promise((done) => {
		server.listen(0, '127.0.0.1', () => {
			endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			done();
		});
	});
}

/** A work dir laid out like the app's root after a deploy (or a local dev-server run). */
function workDir(files: { outputs?: unknown; settings?: unknown }): string {
	const dir = mkdtempSync(join(tmpdir(), 'test-support-secret-'));
	if (files.outputs) {
		mkdirSync(join(dir, '.blocks-sandbox'));
		writeFileSync(join(dir, '.blocks-sandbox', 'outputs.json'), JSON.stringify(files.outputs));
	}
	if (files.settings) {
		mkdirSync(join(dir, '.bb-data'));
		writeFileSync(join(dir, '.bb-data', 'settings.json'), JSON.stringify(files.settings));
	}
	return dir;
}

const DEPLOYED_OUTPUTS = {
	'blocks-sandbox-stub': {
		ApiUrl: 'https://example.invalid/aws-blocks/api',
		TestSupportSecretParameterAB12CD34: PARAMETER_NAME,
	},
};

/** Run the probe under `tsx -C browser` (as the e2e harness runs), with SSM pointed at the stub. */
async function probe(
	mode: 'harness' | 'in-process',
	testEnv: string,
	dir: string,
): Promise<{ result: ProbeResult; output: string }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_OPTIONS: '',
		BLOCKS_TEST_ENV: testEnv,
		AWS_ENDPOINT_URL_SSM: endpoint,
		AWS_REGION: 'us-east-1',
		AWS_ACCESS_KEY_ID: 'AKIDSTUBSTUBSTUB',
		AWS_SECRET_ACCESS_KEY: 'stub',
		AWS_CONFIG_FILE: join(dir, 'no-aws-config'),
		AWS_SHARED_CREDENTIALS_FILE: join(dir, 'no-aws-credentials'),
	};
	for (const name of ['AWS_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_ENDPOINT_URL', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS']) {
		delete env[name];
	}
	const outFile = join(dir, 'probe.json');
	const { stdout, stderr } = await execFileAsync(
		'npx',
		['tsx', '-C', 'browser', 'test/test-support-secret.probe.ts', mode, dir, outFile],
		{ cwd: APP_ROOT, env, encoding: 'utf-8' },
	);
	return { result: JSON.parse(readFileSync(outFile, 'utf-8')), output: stdout + stderr };
}

describe('test-support secret under the browser condition', () => {
	const dirs: string[] = [];
	const track = (dir: string) => {
		dirs.push(dir);
		return dir;
	};

	before(startStub);
	after(() => {
		server.close();
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	test('reading SSM in the browser-condition process itself throws (the sandbox failure)', async () => {
		const { result } = await probe('in-process', 'sandbox', track(workDir({})));
		assert.equal(result.ok, false, 'the AWS SDK built an SSM client under -C browser; this test no longer reproduces FX52');
		assert.equal(result.name, 'TypeError');
		assert.match(result.message ?? '', /emitWarningIfUnsupportedVersion\) is not a function/);
	});

	for (const testEnv of ['sandbox', 'production']) {
		test(`BLOCKS_TEST_ENV=${testEnv}: readTestSupportSecret reads the parameter through the subprocess`, async () => {
			requests.length = 0;
			const { result, output } = await probe('harness', testEnv, track(workDir({ outputs: DEPLOYED_OUTPUTS })));
			assert.deepEqual(result, { ok: true, secret: STUB_SECRET });
			assert.deepEqual(requests, [
				{ target: 'AmazonSSM.GetParameter', body: { Name: PARAMETER_NAME, WithDecryption: true } },
			]);
			assert.ok(!output.includes(STUB_SECRET), 'the secret reached the probe output');
		});
	}

	test('a missing TestSupportSecretParameter output fails with the reason, and no secret', async () => {
		requests.length = 0;
		const outputs = { 'blocks-sandbox-stub': { ApiUrl: 'https://example.invalid/aws-blocks/api' } };
		const { result, output } = await probe('harness', 'sandbox', track(workDir({ outputs })));
		assert.equal(result.ok, false);
		assert.match(result.message ?? '', /TestSupportSecretParameter\* not found/);
		assert.equal(requests.length, 0);
		assert.ok(!output.includes(STUB_SECRET));
	});

	test('BLOCKS_TEST_ENV=local reads the AppSetting mock store, not SSM', async () => {
		requests.length = 0;
		const settings = { 'test-app-test-support-secret': LOCAL_SECRET };
		const { result } = await probe('harness', 'local', track(workDir({ settings })));
		assert.deepEqual(result, { ok: true, secret: LOCAL_SECRET });
		assert.equal(requests.length, 0);
	});
});
