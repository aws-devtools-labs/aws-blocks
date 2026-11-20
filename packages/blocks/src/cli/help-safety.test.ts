// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Help on a passthrough command must never run the tool with the user's
 * arguments. These tests use the real tools behind `secret`, `config`, `db` and
 * `vendorize` (the real runValueCli, the real bb-database and vendorize bins) and a
 * loopback stand-in for SSM and Secrets Manager that records every request, so
 * "no side effect" is observed, not assumed.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as realCore from '@aws-cdk-blocks/core/scripts';
import type { SpawnSpec } from './context.js';
import { type FakeRun, fixtureApp, runCli } from './test-helpers.js';

let server: Server;
let requests: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
/**
 * Settings that could send the SDK calls past the loopback endpoints to real
 * AWS, or replace the fake credentials: cleared for the run.
 */
const ROUTING_ENV = [
	'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
	'AWS_ENDPOINT_URL',
	'AWS_PROFILE',
	'AWS_DEFAULT_PROFILE',
	'AWS_SESSION_TOKEN',
	'AWS_USE_FIPS_ENDPOINT',
	'AWS_USE_DUALSTACK_ENDPOINT',
] as const;
const STORE_ENV = [
	'AWS_REGION',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_ENDPOINT_URL_SSM',
	'AWS_ENDPOINT_URL_SECRETS_MANAGER',
	'AWS_CONFIG_FILE',
	'AWS_SHARED_CREDENTIALS_FILE',
	...ROUTING_ENV,
] as const;

before(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			requests.push(String(req.headers['x-amz-target'] ?? req.url));
			res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
			res.end('{}');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// The SDK clients of the in-process secret/config CLI read process.env.
	for (const name of STORE_ENV) savedEnv[name] = process.env[name];
	Object.assign(process.env, {
		AWS_REGION: 'us-east-1',
		AWS_ACCESS_KEY_ID: 'test',
		AWS_SECRET_ACCESS_KEY: 'test',
		AWS_ENDPOINT_URL_SSM: endpoint,
		AWS_ENDPOINT_URL_SECRETS_MANAGER: endpoint,
		// A shared config file can set ignore_configured_endpoint_urls or another endpoint: read none.
		AWS_CONFIG_FILE: join(fixtureApp(), 'no-aws-config'),
		AWS_SHARED_CREDENTIALS_FILE: join(fixtureApp(), 'no-aws-credentials'),
	});
	for (const name of ROUTING_ENV) delete process.env[name];
});

after(async () => {
	for (const name of STORE_ENV) {
		if (savedEnv[name] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[name];
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
	requests = [];
});

/** The real secret and config CLIs, instead of the test helpers' throwing fakes. */
const REAL_VALUE_CLIS = { runSecretCli: realCore.runSecretCli, runConfigCli: realCore.runConfigCli };

/** Run each spawned child for real, collecting its output. */
function realSpawn(outputs: string[]): (spec: SpawnSpec) => { code: number | null } {
	return (spec) => {
		const child = spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, encoding: 'utf-8' });
		outputs.push(child.stdout + child.stderr);
		return { code: child.status };
	};
}

describe('help never runs a passthrough tool with the user arguments', () => {
	it('the harness sees a real side effect: "config remove KEY" reaches the store', async () => {
		const run = await runCli(['config', 'remove', 'FLAG'], { cwd: fixtureApp(), core: REAL_VALUE_CLIS });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(requests, ['AmazonSSM.DeleteParameter']);
	});

	for (const argv of [
		['help', 'config', 'remove', 'FLAG'],
		['config', 'remove', 'FLAG', '--help'],
		['config', '-h', 'remove', 'FLAG'],
		['help', 'secret', 'remove', 'API_KEY'],
		['secret', 'remove', 'API_KEY', '--force', '--yes', '--help'],
		['secret', 'set', 'API_KEY', '--value-stdin', '--help'],
	]) {
		it(`${argv.join(' ')}: exit 0, usage, no store request`, async () => {
			const stdout: string[] = [];
			const log = console.log;
			console.log = (...args: unknown[]) => stdout.push(args.join(' '));
			let run: FakeRun;
			try {
				run = await runCli(argv, { cwd: fixtureApp(), core: REAL_VALUE_CLIS });
			} finally {
				console.log = log;
			}
			assert.strictEqual(run.code, 0, run.stderr);
			assert.match(stdout.join('\n'), /^Usage: npm run (secret|config) -- (remove|set) /);
			assert.deepStrictEqual(requests, []);
		});
	}

	it('db types help prints usage without writing, even with an output file argument', async () => {
		for (const argv of [
			['help', 'db', 'types'],
			['db', 'types', '--out', './out.ts', '--help'],
		]) {
			const root = fixtureApp();
			const outputs: string[] = [];
			const run = await runCli(argv, { cwd: root, onSpawn: realSpawn(outputs) });
			assert.strictEqual(run.code, 0, `${argv.join(' ')}: ${run.stderr}${outputs.join('')}`);
			assert.deepStrictEqual(run.spawned[0].args.slice(1), ['types', '--help']);
			// bb-database has one usage text for every verb.
			assert.match(
				outputs.join(''),
				/^Usage: npm run db -- <command> \[options\]\n[\s\S]*\n {2}types \[--name <name>\] \[--schema <schema>\] \[--out <file>\]\n/,
			);
			assert.deepStrictEqual(readdirSync(root).sort(), ['.cdk-blocks', 'cdk-blocks', 'package.json']);
		}
	});

	it('db migrate help prints the real migration options', async () => {
		const root = fixtureApp();
		const outputs: string[] = [];
		const run = await runCli(['help', 'db', 'migrate'], { cwd: root, onSpawn: realSpawn(outputs) });
		assert.strictEqual(run.code, 0, run.stderr + outputs.join(''));
		assert.match(
			outputs.join(''),
			/^Usage: npm run db -- <command> \[options\]\n[\s\S]*\n {2}migrate \[dir\] \[--name <name>\] \[--schema <schema>\] \[--types <file> \| --no-types\]\n/,
		);
		assert.ok(!existsSync(join(root, '.cdk-blocks/local/data')));
	});

	it('vendorize help prints usage without starting the vendorize process', async () => {
		for (const argv of [
			['help', 'vendorize', '@aws-cdk-blocks/bb-kv-store'],
			['vendorize', '@aws-cdk-blocks/bb-kv-store', '--help'],
		]) {
			const root = fixtureApp({ workspaces: ['cdk-blocks'] });
			const run = await runCli(argv, { cwd: root, onSpawn: realSpawn([]) });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.match(run.stdout, /Usage: npm run vendorize/);
			assert.deepStrictEqual(run.spawned, []);
			assert.ok(!existsSync(join(root, 'vendor')));
		}
	});

	it('the real vendorize bin prints usage for --help anywhere, before it copies or installs', () => {
		const root = fixtureApp({ workspaces: ['cdk-blocks'] });
		const bin = fileURLToPath(new URL('../vendorize.js', import.meta.url));
		const child = spawnSync(process.execPath, [bin, '@aws-cdk-blocks/bb-kv-store', '--force', '--help'], {
			cwd: root,
			encoding: 'utf-8',
			env: { ...process.env, CDK_DISABLE_CLI_TELEMETRY: '1' },
		});
		assert.strictEqual(child.status, 0, child.stderr);
		assert.match(child.stdout, /^Usage: npm run vendorize <package-name> \[-- --force\]/);
		assert.ok(!existsSync(join(root, 'vendor')));
		assert.ok(!existsSync(join(root, 'node_modules')));
	});
});

describe('delegated commands: input, confirmations and usage errors', () => {
	it('--no-input and CI refuse the hidden secret prompt with exit 2, even on a terminal', async () => {
		for (const [argv, env] of [
			[['--no-input', 'secret', 'set', 'API_KEY'], {}],
			[['secret', 'set', 'API_KEY'], { CI: 'true' }],
		] as const) {
			const run = await runCli([...argv], { cwd: fixtureApp(), stdinIsTTY: true, env, core: REAL_VALUE_CLIS });
			assert.strictEqual(run.code, 2, `${argv.join(' ')}: ${run.stderr}`);
			assert.match(run.stderr, /this run cannot prompt \(--no-input or CI\).*--value-stdin/);
			assert.deepStrictEqual(requests, []);
		}
	});

	it('maps the secret and config usage errors to exit 2', async () => {
		for (const [argv, message] of [
			[['secret', 'remove'], /Usage: npm run secret -- remove <KEY>/],
			[['secret', 'frob'], /Unknown subcommand "frob"/],
			[['config', 'set'], /Usage: npm run config -- set <KEY>/],
			[['secret', 'list', '--stage'], /--stage` requires a value/],
			[['secret', 'remove', 'API_KEY', '--force'], /Refusing to force-delete .*--yes/],
		] as const) {
			const run = await runCli([...argv], { cwd: fixtureApp(), core: REAL_VALUE_CLIS });
			assert.strictEqual(run.code, 2, `${argv.join(' ')}: ${run.stderr}`);
			assert.match(run.stderr, message);
		}
		assert.deepStrictEqual(requests, []);
	});

	it('the global --yes confirms "secret remove --force" like --yes after the command', async () => {
		for (const argv of [
			['--yes', 'secret', 'remove', 'API_KEY', '--force'],
			['secret', 'remove', 'API_KEY', '--force', '--yes'],
		]) {
			requests = [];
			const run = await runCli(argv, { cwd: fixtureApp(), core: REAL_VALUE_CLIS });
			assert.strictEqual(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
			// A forced delete first checks that the secret exists.
			assert.deepStrictEqual(
				requests,
				['secretsmanager.DescribeSecret', 'secretsmanager.DeleteSecret'],
				argv.join(' '),
			);
		}
	});

	it('validates the db verb before spawning', async () => {
		const unknown = await runCli(['db', 'migrat'], { cwd: fixtureApp() });
		assert.strictEqual(unknown.code, 2);
		assert.match(unknown.stderr, /unknown db verb "migrat".*Did you mean "migrate"\?/);
		assert.deepStrictEqual(unknown.spawned, []);
	});

	it('db connect without input returns the exit code in its delegated help, without prompting or storing a value', async () => {
		const cwd = fixtureApp();
		const help: string[] = [];
		const usage = await runCli(['db', 'connect', '--help'], { cwd, onSpawn: realSpawn(help) });
		assert.strictEqual(usage.code, 0, usage.stderr);
		assert.match(help.join(''), /^Usage: npm run db -- <command> \[options\]/);
		assert.match(help.join(''), /--no-input +never ask; fail with exit code 2 where a question would be needed/);
		for (const [argv, stdinIsTTY, env] of [
			[['db', 'connect'], false, {}],
			[['--no-input', 'db', 'connect'], true, {}],
			[['db', 'connect'], true, { CI: '1' }],
		] as const) {
			const outputs: string[] = [];
			const run = await runCli([...argv], { cwd, stdinIsTTY, env, onSpawn: realSpawn(outputs) });
			assert.strictEqual(run.code, 2, run.stderr + outputs.join(''));
			assert.deepStrictEqual(run.spawned[0].args.slice(1), ['connect', '--no-input']);
			assert.match(outputs.join(''), /pass the connection string on stdin with --value-stdin/);
			assert.ok(!existsSync(join(cwd, '.cdk-blocks/local/data')));
		}
	});
});
