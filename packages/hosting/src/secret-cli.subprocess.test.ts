// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end `remove --force` safeguards (PR #850 review, S3): runs the real
 * `hosting-secret` bin in a subprocess against a loopback stand-in for Secrets
 * Manager, so the assertions cover argv parsing, the confirmation gate, the
 * warning on stderr and the exact request that reaches the store (or that none
 * does).
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), 'secret-cli-bin.js');

interface StoreCall {
	target: string;
	body: Record<string, unknown>;
}

let server: Server;
let endpoint: string;
let calls: StoreCall[] = [];

before(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk: Buffer) => {
			raw += chunk.toString('utf8');
		});
		req.on('end', () => {
			const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
			calls.push({ target: String(req.headers['x-amz-target'] ?? ''), body });
			res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
			res.end(
				JSON.stringify({ ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:x', Name: body.SecretId }),
			);
		});
	});
	// Loopback only, ephemeral port: a test double, never reachable off-host.
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	calls = [];
});

function runBin(args: string[], bin = BIN): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [bin, ...args], {
			env: {
				PATH: process.env.PATH ?? '',
				AWS_REGION: 'us-east-1',
				AWS_ACCESS_KEY_ID: 'test',
				AWS_SECRET_ACCESS_KEY: 'test',
				AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
				AWS_ENDPOINT_URL_SSM: endpoint,
				AWS_CONFIG_FILE: join(dirname(BIN), 'no-such-aws-config'),
				AWS_SHARED_CREDENTIALS_FILE: join(dirname(BIN), 'no-such-aws-credentials'),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c: Buffer) => {
			stdout += c.toString('utf8');
		});
		child.stderr.on('data', (c: Buffer) => {
			stderr += c.toString('utf8');
		});
		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

void describe('hosting-secret remove --force (subprocess, loopback Secrets Manager)', () => {
	for (const [label, args] of [
		['--stage prod', ['--stage', 'prod']],
		['--stage=Production', ['--stage=Production']],
		['no stage (shared namespace)', []],
		['an empty --stage= (resolves to the shared namespace)', ['--stage=']],
		['--stage prod-us-east-1', ['--stage', 'prod-us-east-1']],
		['--stage live', ['--stage', 'live']],
		['--stage dev (every stage needs --yes)', ['--stage', 'dev']],
	] as const) {
		void it(`refuses without --yes and sends nothing to the store: ${label}`, async () => {
			const r = await runBin(['remove', 'DB_PASSWORD', '--force', ...args]);
			assert.strictEqual(r.code, 1, r.stderr);
			assert.match(r.stderr, /Refusing to force-delete .*'DB_PASSWORD'.*--yes/s);
			assert.deepStrictEqual(calls, []);
		});
	}

	void it('with --yes on prod: warns naming the stage, then force-deletes the staged secret', async () => {
		const r = await runBin(['remove', 'DB_PASSWORD', '--force', '--yes', '--stage', 'prod']);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.match(r.stderr, /Force-deleting secret 'DB_PASSWORD' \(stage 'prod'\).*no recovery window/);
		assert.strictEqual(calls.length, 1);
		assert.match(calls[0].target, /DeleteSecret$/);
		assert.strictEqual(calls[0].body.ForceDeleteWithoutRecovery, true);
		assert.match(String(calls[0].body.SecretId), /\/prod\/DB_PASSWORD$/);
	});

	void it('-y on the shared namespace: warns that every stage shares it, then force-deletes', async () => {
		const r = await runBin(['remove', 'DB_PASSWORD', '--force', '-y']);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.match(r.stderr, /shared by every stage, including production/);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].body.ForceDeleteWithoutRecovery, true);
		assert.doesNotMatch(String(calls[0].body.SecretId), /\/prod\//);
	});

	void it('-y on a named non-prod stage: warns naming the stage, then force-deletes', async () => {
		const r = await runBin(['remove', 'DB_PASSWORD', '--force', '-y', '--stage', 'dev']);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.match(r.stderr, /Force-deleting secret 'DB_PASSWORD' \(stage 'dev'\)/);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].body.ForceDeleteWithoutRecovery, true);
		assert.match(String(calls[0].body.SecretId), /\/dev\/DB_PASSWORD$/);
	});

	void it('without --force on prod: a recoverable delete, no warning, no --yes needed', async () => {
		const r = await runBin(['remove', 'DB_PASSWORD', '--stage', 'prod']);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.doesNotMatch(r.stderr, /Force-deleting/);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].body.ForceDeleteWithoutRecovery, undefined);
	});
});

const CONFIG_BIN = join(dirname(BIN), 'config-cli-bin.js');

void describe('hosting-secret and hosting-config --help (subprocess, loopback stores)', () => {
	for (const [bin, args] of [
		[BIN, ['remove', 'DB_PASSWORD', '--help']],
		[BIN, ['remove', 'DB_PASSWORD', '--force', '--yes', '-h']],
		[BIN, ['--help', 'remove', 'DB_PASSWORD']],
		[BIN, ['set', 'API_KEY', '--value-stdin', '--help']],
		[BIN, ['list', '--stage', 'prod', '-h']],
		[BIN, ['--stage', '--help']],
		[CONFIG_BIN, ['remove', 'FLAG', '--help']],
		[CONFIG_BIN, ['set', 'FLAG', 'on', '--help']],
	] as const) {
		void it(`${bin === BIN ? 'hosting-secret' : 'hosting-config'} ${args.join(' ')}: usage, exit 0, nothing sent`, async () => {
			const r = await runBin([...args], bin);
			assert.strictEqual(r.code, 0, r.stderr);
			assert.match(r.stdout, /^Usage: hosting-(secret|config) /);
			assert.match(r.stdout, /-h, --help|--help" for the options/);
			assert.deepStrictEqual(calls, []);
		});
	}

	void it('secret remove --help documents --force/--yes, --stage, --prefix and --region as implemented', async () => {
		const r = await runBin(['remove', '--help']);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.match(
			r.stdout,
			/^Usage: hosting-secret remove <KEY> \[--force --yes\] \[--stage <name>\] \[--prefix <path>\] \[--region <name>\]/,
		);
		assert.match(r.stdout, /recovery\s+window/);
		assert.match(r.stdout, /--force {12}Delete at once, with no recovery window\. Requires --yes\./);
		// Secrets Manager names drop the leading slash of the prefix.
		assert.match(
			r.stdout,
			/--stage <name> {5}Use the store name hosting\/secrets\/<name>\/<KEY> instead of hosting\/secrets\/<KEY>\./,
		);
		assert.match(r.stdout, /no fixed list/);
		assert.match(r.stdout, /--prefix <path> {4}Store prefix \(default: \/hosting\/secrets\)/);
		assert.match(r.stdout, /--region <name>/);
	});

	void it('config set --help shows the SSM path and the positional value', async () => {
		const r = await runBin(['set', '--help'], CONFIG_BIN);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.match(r.stdout, /^Usage: hosting-config set <KEY> \[<value>\] \[--value-stdin\]/);
		assert.match(r.stdout, /\/hosting\/config\/<name>\/<KEY> instead of \/hosting\/config\/<KEY>/);
		assert.doesNotMatch(r.stdout, /--force/);
	});

	void it('without --help, the commands still run: config remove reaches the store', async () => {
		const r = await runBin(['remove', 'FLAG'], CONFIG_BIN);
		assert.strictEqual(r.code, 0, r.stderr);
		assert.strictEqual(calls.length, 1);
		assert.match(calls[0].target, /DeleteParameter$/);
	});
});
