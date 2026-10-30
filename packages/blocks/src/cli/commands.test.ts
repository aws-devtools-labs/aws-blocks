// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AwsIdentity } from '@aws-blocks/core/scripts';
import { redactArgs } from './commands.js';
import { type SpawnSpec, stageEnv } from './context.js';
import type { LastDeploy } from './runners/last-deploy.js';
import { DEV_OPTIONS_ENV, type RunnerName, runnerPath, TSX_IMPORT_ENV } from './runners/launch.js';
import { fixtureApp, runCli } from './test-helpers.js';

const IDENTITY: AwsIdentity = {
	credentials: 'AWS profile dev',
	profile: 'dev',
	region: 'us-east-1',
	account: '123456789012',
	arn: 'arn:aws:iam::123456789012:user/dev',
};

const AWS_ENV = { AWS_REGION: 'us-east-1' };

/** The options a runner received as JSON in argv[2]. */
function runnerOptions(spec: SpawnSpec, runner: RunnerName): unknown {
	const at = spec.args.indexOf(runnerPath(runner));
	assert.ok(at > 0, `${runner} runner was spawned: ${spec.args.join(' ')}`);
	return JSON.parse(spec.args[at + 1]);
}

describe('passthrough commands', () => {
	it('forwards secret and config arguments verbatim, from the project root', async () => {
		const root = fixtureApp();
		const sub = join(root, 'aws-blocks');
		const calls: string[][] = [];
		const argv = ['set', 'API_KEY', '--value-stdin', '--stage', 'production', '--region', 'eu-west-1'];
		const run = await runCli(['secret', ...argv], {
			cwd: sub,
			core: {
				runSecretCli: async (args) => {
					calls.push(args);
				},
			},
		});
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(calls, [argv]);
		assert.deepStrictEqual(run.chdirs, [root]);

		const config = await runCli(['config', 'set', 'FLAG', 'on'], {
			cwd: root,
			core: {
				runConfigCli: async (args) => {
					calls.push(args);
				},
			},
		});
		assert.strictEqual(config.code, 0, config.stderr);
		assert.deepStrictEqual(calls[1], ['set', 'FLAG', 'on']);
	});

	it('reports a secret CLI error in the CLI format with exit 1', async () => {
		const run = await runCli(['secret', 'set'], {
			cwd: fixtureApp(),
			core: {
				runSecretCli: async () => {
					throw new Error('Usage: blocks secret set <KEY>');
				},
			},
		});
		assert.strictEqual(run.code, 1);
		assert.match(run.stderr, /^Error: Usage: blocks secret set <KEY>\n/);
	});

	it('forwards db verbs and every argument to the bb-data CLI', async () => {
		const root = fixtureApp();
		const run = await runCli(['db', 'status', './db/migrations', '--url', 'postgres://x'], { cwd: root });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		assert.strictEqual(spec.command, process.execPath);
		assert.match(spec.args[0], /bb-data[\\/]dist[\\/]cli\.js$/);
		assert.deepStrictEqual(spec.args.slice(1), ['status', './db/migrations', '--url', 'postgres://x']);
		assert.strictEqual(spec.cwd, root);
	});

	it('forwards only "<verb> --help" when --help appears anywhere after db, secret or config', async () => {
		const root = fixtureApp();
		const db = await runCli(['db', 'status', './dir', '--url', 'postgres://x', '--help'], { cwd: root });
		assert.strictEqual(db.code, 0, db.stderr);
		assert.deepStrictEqual(db.spawned[0].args.slice(1), ['status', '--help']);
		const calls: string[][] = [];
		const secret = await runCli(['secret', '--stage', 'prod', 'remove', 'API_KEY', '--force', '--yes', '-h'], {
			cwd: root,
			core: {
				runSecretCli: async (args) => {
					calls.push(args);
				},
			},
		});
		assert.strictEqual(secret.code, 0, secret.stderr);
		assert.deepStrictEqual(calls, [['remove', '--help']]);
		// No verb (or an unknown one): the CLI's own help, and nothing runs.
		const vendorize = await runCli(['vendorize', '@aws-blocks/bb-kv-store', '--force', '--help'], { cwd: root });
		assert.strictEqual(vendorize.code, 0, vendorize.stderr);
		assert.match(vendorize.stdout, /Usage: blocks vendorize/);
		assert.strictEqual(vendorize.spawned.length, 0);
		const unknown = await runCli(['db', 'drop', '--help'], { cwd: root });
		assert.match(unknown.stdout, /Usage: blocks db <verb>/);
		assert.strictEqual(unknown.spawned.length, 0);
	});

	it('requires a db verb', async () => {
		const run = await runCli(['db'], { cwd: fixtureApp() });
		assert.strictEqual(run.code, 2);
		assert.match(run.stderr, /needs a verb/);
		assert.strictEqual(run.spawned.length, 0);
	});

	it('forwards vendorize arguments verbatim', async () => {
		const run = await runCli(['vendorize', '@aws-blocks/bb-kv-store', '--force'], { cwd: fixtureApp() });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		assert.match(spec.args[0], /dist[\\/]vendorize\.js$/);
		assert.deepStrictEqual(spec.args.slice(1), ['@aws-blocks/bb-kv-store', '--force']);
	});

	it('maps telemetry subcommands and flags to the core telemetry argv', async () => {
		const seen: string[][] = [];
		const core = {
			telemetry: async (options?: { argv?: string[] }) => {
				seen.push(options?.argv ?? []);
			},
		};
		const cwd = fixtureApp();
		for (const argv of [['telemetry'], ['telemetry', 'disable', '--global'], ['telemetry', '--enable']]) {
			const run = await runCli(argv, { cwd, core });
			assert.strictEqual(run.code, 0, run.stderr);
		}
		assert.deepStrictEqual(seen, [
			['node', 'blocks', '--status'],
			['node', 'blocks', '--disable', '--global'],
			['node', 'blocks', '--enable'],
		]);
		const conflict = await runCli(['telemetry', 'enable', '--disable'], { cwd, core });
		assert.strictEqual(conflict.code, 2);
	});
});

describe('lifecycle commands', () => {
	it('runs dev under tsx watch with the resolved options', async () => {
		const root = fixtureApp();
		const run = await runCli(['dev', '--port', '4000'], { cwd: root });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		assert.match(spec.args[0], /tsx[\\/]dist[\\/]cli\.mjs$/);
		assert.strictEqual(spec.args[1], 'watch');
		assert.strictEqual(spec.args[2], runnerPath('dev-server'));
		assert.deepStrictEqual(JSON.parse(spec.env[DEV_OPTIONS_ENV] ?? ''), {
			backendPath: join(root, 'aws-blocks', 'index.ts'),
			port: 4000,
			frontendCommand: 'npx vite --port 3100 --strictPort',
			frontendPort: 3100,
		});
		assert.strictEqual(spec.env.BLOCKS_LOG_LEVEL, 'normal');
	});

	it('runs sandbox with the dev server runner as its dev command', async () => {
		const root = fixtureApp({ dependencies: { next: '*' }, blocks: { dev: { port: 3005 } } });
		const run = await runCli(['sandbox'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		const options = runnerOptions(spec, 'sandbox') as { devCommand: string };
		assert.deepStrictEqual(
			{ ...options, devCommand: undefined },
			{
				backendPath: join(root, 'aws-blocks', 'index.cdk.ts'),
				deployOnly: false,
				devCommand: undefined,
				clientPort: 3005,
			},
		);
		assert.match(options.devCommand, /cli\.mjs' 'watch' '.*dev-server\.js'$/);
		// The runner and core's client generation in it load the same tsx, by URL; the dev command uses its CLI.
		const loader = spec.env[TSX_IMPORT_ENV] ?? '';
		assert.match(loader, /^file:.*[\\/]tsx[\\/]dist[\\/]loader\.mjs$/);
		assert.deepStrictEqual(spec.args.slice(0, 3), ['--import', loader, runnerPath('sandbox')]);
		assert.ok(options.devCommand.includes(join(fileURLToPath(loader), '..', 'cli.mjs')), options.devCommand);
		// package.json "blocks.dev" without a frontendCommand keeps auto-detection on.
		assert.deepStrictEqual(JSON.parse(spec.env[DEV_OPTIONS_ENV] ?? ''), {
			backendPath: join(root, 'aws-blocks', 'index.ts'),
			port: 3005,
			frontendCommand: 'npx next dev --webpack --hostname 127.0.0.1 --port 3100',
			frontendPort: 3100,
		});
	});

	it('runs sandbox destroy under --conditions=cdk without a prompt when not interactive', async () => {
		const root = fixtureApp();
		const run = await runCli(['sandbox', 'destroy'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		assert.deepStrictEqual(spec.args.slice(0, 4), [
			'--conditions=cdk',
			'--import',
			spec.env[TSX_IMPORT_ENV],
			runnerPath('sandbox-destroy'),
		]);
		assert.deepStrictEqual(runnerOptions(spec, 'sandbox-destroy'), {
			backendPath: join(root, 'aws-blocks', 'index.cdk.ts'),
		});
		assert.match(run.stderr, /production stack is not affected/);
		assert.deepStrictEqual(run.prompts, []);
	});

	it('forwards --wait-live as core reads it from argv', async () => {
		const root = fixtureApp();
		const run = await runCli(['deploy', '--wait-live=30'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		assert.deepStrictEqual(runnerOptions(spec, 'deploy'), {
			cdkAppPath: join(root, 'aws-blocks', 'index.cdk.ts'),
			projectRoot: root,
		});
		assert.deepStrictEqual(spec.args.slice(-2), ['--wait-live', '--wait-live-timeout=30']);
		assert.match(run.stderr, /Deploying the production stack demo-prod; Region us-east-1/);
	});

	it('forwards --telemetry-file to every runner as core reads it, in either form and position', async () => {
		const root = fixtureApp();
		const file = join(root, 'events.json');
		for (const argv of [
			['dev', '--telemetry-file=events.json'],
			['dev', '--telemetry-file', 'events.json'],
			['--telemetry-file', file, 'dev'],
		]) {
			const run = await runCli(argv, { cwd: root });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.deepStrictEqual(run.spawned[0].args.slice(-1), [`--telemetry-file=${file}`], argv.join(' '));
		}
		const deploy = await runCli(['deploy', '--wait-live', '--telemetry-file=events.json'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(deploy.code, 0, deploy.stderr);
		assert.deepStrictEqual(deploy.spawned[0].args.slice(-2), ['--wait-live', `--telemetry-file=${file}`]);
		const sandbox = await runCli(['sandbox', 'destroy', '--telemetry-file=events.json'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(sandbox.code, 0, sandbox.stderr);
		assert.deepStrictEqual(sandbox.spawned[0].args.slice(-1), [`--telemetry-file=${file}`]);
		// Without the flag, no runner gets one.
		const plain = await runCli(['dev'], { cwd: root });
		assert.ok(!plain.spawned[0].args.some((arg) => arg.startsWith('--telemetry-file')));
	});

	it('runs "sandbox --deploy-only", the old script flag, as "sandbox deploy"', async () => {
		const root = fixtureApp();
		const run = await runCli(['sandbox', '--deploy-only'], { cwd: root, env: AWS_ENV });
		// The fake runner records no deploy result, so the deploy-only path exits 1 after it ran.
		const options = runnerOptions(run.spawned[0], 'sandbox') as { deployOnly: boolean };
		assert.strictEqual(options.deployOnly, true, run.stderr);
		assert.strictEqual(run.spawned[0].terminateOnHangup, false);
	});

	it('exports a configured dev host as BLOCKS_DEV_HOST, which opts /realtime into it', async () => {
		const root = fixtureApp({ blocks: { dev: { host: 'mybox.example.com' } } });
		const run = await runCli(['dev', '--no-frontend'], { cwd: root });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.strictEqual(run.spawned[0].env.BLOCKS_DEV_HOST, 'mybox.example.com');
		const flagged = await runCli(['dev', '--host', '0.0.0.0'], { cwd: root });
		assert.strictEqual(flagged.spawned[0].env.BLOCKS_DEV_HOST, '0.0.0.0');
		const sandbox = await runCli(['sandbox'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(sandbox.spawned[0].env.BLOCKS_DEV_HOST, 'mybox.example.com');
		// Without a host, the inherited environment decides, as core's dev server does.
		const plain = await runCli(['dev'], { cwd: fixtureApp(), env: { BLOCKS_DEV_HOST: 'other.example.com' } });
		assert.strictEqual(plain.spawned[0].env.BLOCKS_DEV_HOST, 'other.example.com');
	});

	it('keeps an inherited BLOCKS_DEV_HOST over --host, and exports the host when none is inherited', async () => {
		const root = fixtureApp();
		const inherited = await runCli(['dev', '--host', '0.0.0.0'], { cwd: root, env: { BLOCKS_DEV_HOST: 'mybox.example.com' } });
		assert.strictEqual(inherited.spawned[0].env.BLOCKS_DEV_HOST, 'mybox.example.com');
		const configured = fixtureApp({ blocks: { dev: { host: '0.0.0.0' } } });
		const sandbox = await runCli(['sandbox'], { cwd: configured, env: { ...AWS_ENV, BLOCKS_DEV_HOST: 'mybox.example.com' } });
		assert.strictEqual(sandbox.spawned[0].env.BLOCKS_DEV_HOST, 'mybox.example.com');
		const fresh = await runCli(['dev', '--host', '0.0.0.0'], { cwd: root, env: {} });
		assert.strictEqual(fresh.spawned[0].env.BLOCKS_DEV_HOST, '0.0.0.0');
	});

	it('maps child exit codes: 2 stays a usage error, others become 1, SIGINT 130', async () => {
		const cwd = fixtureApp();
		for (const [result, expected] of [
			[{ code: 2 }, 2],
			[{ code: 7 }, 1],
			[{ code: null, signal: 'SIGINT' as const }, 130],
			[{ code: 0, interrupted: true }, 130],
		] as const) {
			const run = await runCli(['vendorize', 'x'], { cwd, onSpawn: () => result });
			assert.strictEqual(run.code, expected, JSON.stringify(result));
		}
		const failed = await runCli(['vendorize', 'x'], { cwd, onSpawn: () => ({ code: 7 }) });
		assert.match(failed.stderr, /^Error: blocks vendorize failed \(exit code 7\)\.\n {2}project: /);
	});

	it('turns a SIGHUP into a SIGTERM only for the watch runners: dev and sandbox', async () => {
		const cwd = fixtureApp();
		for (const [argv, terminate] of [
			[['dev'], true],
			[['sandbox'], true],
			[['sandbox', 'deploy'], false],
			[['sandbox', 'destroy'], false],
			[['deploy'], false],
			[['destroy', '--yes'], false],
		] as const) {
			const run = await runCli([...argv], { cwd, env: AWS_ENV });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.strictEqual(run.spawned[0].terminateOnHangup ?? false, terminate, argv.join(' '));
		}
	});

	it('runs every runner but the dev server with the tsx loader, with no tsx process in between', async () => {
		const cwd = fixtureApp();
		for (const [argv, runner] of [
			[['sandbox', 'deploy'], 'sandbox'],
			[['deploy'], 'deploy'],
			[['destroy', '--yes'], 'destroy'],
			[['generate', 'spec'], 'generate-spec'],
		] as const) {
			const run = await runCli([...argv], { cwd, env: AWS_ENV });
			assert.strictEqual(run.code, 0, run.stderr);
			const [spec] = run.spawned;
			assert.strictEqual(spec.command, process.execPath);
			assert.deepStrictEqual(spec.args.slice(0, 3), ['--import', spec.env[TSX_IMPORT_ENV], runnerPath(runner)]);
			assert.ok(!spec.args.some((arg) => /tsx[\\/]dist[\\/]cli\.mjs$/.test(arg)), argv.join(' '));
		}
	});
});

describe('help for passthrough subcommands', () => {
	it('runs "help db migrate" as "db migrate --help", forwarding --help to bb-data', async () => {
		const root = fixtureApp();
		const viaHelp = await runCli(['help', 'db', 'migrate'], { cwd: root });
		const direct = await runCli(['db', 'migrate', '--help'], { cwd: root });
		assert.strictEqual(viaHelp.code, 0, viaHelp.stderr);
		assert.deepStrictEqual(viaHelp.spawned, direct.spawned);
		assert.deepStrictEqual(viaHelp.spawned[0].args.slice(1), ['migrate', '--help']);
		// Extra tokens after the verb never reach the tool.
		const extra = await runCli(['help', 'db', 'migrate', './dir', 'postgres://u:p@h/db'], { cwd: root });
		assert.deepStrictEqual(extra.spawned[0].args.slice(1), ['migrate', '--help']);
		const vendorize = await runCli(['help', 'vendorize', '@aws-blocks/bb-kv-store'], { cwd: root });
		assert.match(vendorize.stdout, /Usage: blocks vendorize/);
		assert.strictEqual(vendorize.spawned.length, 0);
	});

	it('forwards "help secret set" to the secret CLI, and rejects unknown paths', async () => {
		const calls: string[][] = [];
		const cwd = fixtureApp();
		const run = await runCli(['help', 'secret', 'set'], {
			cwd,
			core: {
				runSecretCli: async (args) => {
					calls.push(args);
				},
			},
		});
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(calls, [['set', '--help']]);
		const db = await runCli(['help', 'db'], { cwd });
		assert.match(db.stdout, /Usage: blocks db <verb>/);
		assert.strictEqual(db.spawned.length, 0);
		const unknown = await runCli(['help', 'sandbox', 'destory'], { cwd });
		assert.strictEqual(unknown.code, 2);
		assert.match(unknown.stderr, /unknown command "sandbox destory"\. Did you mean "sandbox destroy"\?/);
	});
});

describe('destroy safety', () => {
	it('exits 2 without a TTY and without --yes, after printing the target', async () => {
		const root = fixtureApp();
		const run = await runCli(['destroy'], { cwd: root, env: AWS_ENV, stdinIsTTY: false });
		assert.strictEqual(run.code, 2);
		assert.strictEqual(run.spawned.length, 0);
		assert.strictEqual(run.stdout, '');
		assert.match(run.stderr, /This deletes the production stack demo-prod/);
		assert.match(run.stderr, /Try: blocks destroy --yes\n/);
	});

	it('treats CI and --no-input as non-interactive even with a TTY', async () => {
		const cwd = fixtureApp();
		const ci = await runCli(['destroy'], { cwd, env: { ...AWS_ENV, CI: 'true' }, stdinIsTTY: true });
		assert.strictEqual(ci.code, 2);
		const noInput = await runCli(['--no-input', 'destroy'], { cwd, env: AWS_ENV, stdinIsTTY: true });
		assert.strictEqual(noInput.code, 2);
		assert.deepStrictEqual([...ci.prompts, ...noInput.prompts], []);
	});

	it('asks in a TTY and deletes nothing unless the answer is yes', async () => {
		const cwd = fixtureApp();
		const declined = await runCli(['destroy'], { cwd, env: AWS_ENV, stdinIsTTY: true, answer: 'n' });
		assert.strictEqual(declined.code, 1);
		assert.strictEqual(declined.spawned.length, 0);
		assert.match(declined.prompts[0], /Delete the production stack demo-prod\? \[y\/N\]/);
		const accepted = await runCli(['destroy'], { cwd, env: AWS_ENV, stdinIsTTY: true, answer: 'yes' });
		assert.strictEqual(accepted.code, 0, accepted.stderr);
		runnerOptions(accepted.spawned[0], 'destroy');
	});

	it('exits 130 and deletes nothing on Ctrl-C at the destroy and sandbox destroy prompts', async () => {
		const cwd = fixtureApp();
		for (const argv of [['destroy'], ['sandbox', 'destroy']]) {
			const run = await runCli(argv, { cwd, env: AWS_ENV, stdinIsTTY: true, answer: null });
			assert.strictEqual(run.code, 130, argv.join(' '));
			assert.strictEqual(run.prompts.length, 1, argv.join(' '));
			assert.strictEqual(run.spawned.length, 0, argv.join(' '));
			assert.match(run.stderr, /Interrupted; nothing was deleted\.\n$/);
		}
	});

	it('runs with --yes and no prompt', async () => {
		const run = await runCli(['destroy', '--yes'], { cwd: fixtureApp(), env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(run.prompts, []);
		assert.strictEqual(run.spawned.length, 1);
	});

	it('names environment access keys that override AWS_PROFILE, and warns even with --quiet', async () => {
		const keys = { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_PROFILE: 'prod-admin' };
		const cwd = fixtureApp();
		const declined = await runCli(['destroy'], {
			cwd,
			env: { ...AWS_ENV, ...keys },
			stdinIsTTY: true,
			answer: 'n',
		});
		assert.match(
			declined.stderr,
			/This deletes the production stack demo-prod; Region us-east-1, credentials: access keys in AWS_ACCESS_KEY_ID \(used instead of AWS_PROFILE\)/,
		);
		assert.doesNotMatch(declined.stderr, /profile prod-admin;/);
		assert.match(
			declined.stderr,
			/Warning: access keys in the environment are set, so CDK uses them instead of the profile "prod-admin"/,
		);
		for (const argv of [
			['--quiet', 'destroy', '--yes'],
			['--quiet', 'deploy'],
			['--profile', 'other', '-q', 'deploy'],
		]) {
			const run = await runCli(argv, { cwd, env: { ...AWS_ENV, ...keys } });
			assert.match(run.stderr, /Warning: access keys in the environment are set/, argv.join(' '));
		}
		// A profile alone is named as the profile, with no warning.
		const profile = await runCli(['destroy', '--yes'], { cwd, env: { ...AWS_ENV, AWS_PROFILE: 'dev' } });
		assert.match(profile.stderr, /credentials: AWS profile dev/);
		assert.doesNotMatch(profile.stderr, /Warning/);
	});
});

describe('verbose echo', () => {
	it('masks URL passwords and --url values in the echoed command line', async () => {
		assert.deepStrictEqual(
			redactArgs([
				'status',
				'--url',
				'postgres://u:p@h/db',
				'--url=postgresql://a:b@c:5432/d',
				'x://user:pw@host',
			]),
			['status', '--url', '***', '--url=***', 'x://user:***@host'],
		);
		assert.deepStrictEqual(redactArgs(['migrate', './dir', 'https://example.com/a']), [
			'migrate',
			'./dir',
			'https://example.com/a',
		]);
		const run = await runCli(
			[
				'--verbose',
				'db',
				'migrate',
				'postgres://admin:hunter2@db.example.com/app',
				'--url',
				'postgres://u:pw@h/db',
			],
			{ cwd: fixtureApp() },
		);
		assert.strictEqual(run.code, 0, run.stderr);
		assert.match(run.stderr, /> .*migrate postgres:\/\/admin:\*\*\*@db\.example\.com\/app --url \*\*\*/);
		assert.doesNotMatch(run.stderr, /hunter2|u:pw/);
		// The child still gets the real arguments.
		assert.deepStrictEqual(run.spawned[0].args.slice(-3), [
			'postgres://admin:hunter2@db.example.com/app',
			'--url',
			'postgres://u:pw@h/db',
		]);
	});
});

describe('stage env files', () => {
	/** An app whose .env.production and .env.local set other Regions than the shell. */
	function stagedApp(): string {
		const root = fixtureApp();
		writeFileSync(join(root, '.env.production'), 'AWS_REGION=eu-west-2\nAPP_FLAG=prod\n');
		writeFileSync(join(root, '.env.local'), 'AWS_REGION=ap-south-1\n');
		return root;
	}

	it('applies a stage env file to a copy of the environment, as core does', () => {
		const root = stagedApp();
		const env: NodeJS.ProcessEnv = { APP_FLAG: '' };
		assert.deepStrictEqual(stageEnv(env, root, 'production'), { APP_FLAG: '', AWS_REGION: 'eu-west-2' });
		assert.deepStrictEqual(stageEnv({ AWS_REGION: 'us-west-1' }, root, 'sandbox'), { AWS_REGION: 'us-west-1' });
		assert.deepStrictEqual(env, { APP_FLAG: '' });
		assert.deepStrictEqual(stageEnv({ A: '1' }, fixtureApp(), 'production'), { A: '1' });
	});

	it('resolves whoami with .env.production, and names what .env.local sets differently', async () => {
		const seen: NodeJS.ProcessEnv[] = [];
		const run = await runCli(['whoami', '--output', 'json'], {
			cwd: stagedApp(),
			core: {
				readAwsIdentity: async ({ env }) => {
					seen.push(env ?? {});
					return { ...IDENTITY, region: env?.AWS_REGION ?? null };
				},
			},
		});
		assert.strictEqual(run.code, 0, run.stderr);
		assert.strictEqual(seen[0].AWS_REGION, 'eu-west-2');
		assert.strictEqual(JSON.parse(run.stdout).region, 'eu-west-2');
		assert.match(run.stderr, /Warning: \.env\.local sets AWS_REGION unlike \.env\.production/);
	});

	it('warns about .env.local only when it exists and sets a different value', async () => {
		const whoami = (root: string) =>
			runCli(['whoami'], {
				cwd: root,
				core: { readAwsIdentity: async ({ env }) => ({ ...IDENTITY, region: env?.AWS_REGION ?? null }) },
			});
		const noLocal = fixtureApp();
		writeFileSync(join(noLocal, '.env.production'), 'AWS_REGION=us-west-2\n');
		const missing = await whoami(noLocal);
		assert.strictEqual(missing.code, 0, missing.stderr);
		assert.doesNotMatch(missing.stderr, /Warning/);
		const same = fixtureApp();
		writeFileSync(join(same, '.env.production'), 'AWS_REGION=us-west-2\nAWS_PROFILE=prod\n');
		writeFileSync(join(same, '.env.local'), 'AWS_REGION=us-west-2\nAPP_FLAG=local\n');
		assert.doesNotMatch((await whoami(same)).stderr, /Warning/);
		// The shell's value wins in both stages, so the files cannot differ there.
		const shell = await runCli(['whoami'], {
			cwd: stagedApp(),
			env: { AWS_REGION: 'us-west-1' },
			core: { readAwsIdentity: async () => IDENTITY },
		});
		assert.doesNotMatch(shell.stderr, /Warning/);
		const profile = fixtureApp();
		writeFileSync(join(profile, '.env.local'), 'AWS_PROFILE=sandbox\n');
		assert.match((await whoami(profile)).stderr, /Warning: \.env\.local sets AWS_PROFILE unlike \.env\.production/);
	});

	it('prints the target line of deploy and sandbox with their stage env file', async () => {
		const root = stagedApp();
		const deploy = await runCli(['deploy'], { cwd: root });
		assert.match(deploy.stderr, /Deploying the production stack demo-prod; Region eu-west-2,/);
		const sandbox = await runCli(['sandbox', 'deploy'], { cwd: root });
		assert.match(sandbox.stderr, /Sandbox stack: \(created on the first deploy\); Region ap-south-1,/);
		// The shell's own setting wins over the file, as in core.
		const shell = await runCli(['deploy'], { cwd: root, env: { AWS_REGION: 'us-west-1' } });
		assert.match(shell.stderr, /; Region us-west-1,/);
	});
});

describe('whoami with the real credential chain', () => {
	/** A loopback STS stand-in: each access key belongs to one account; records the keys that signed. */
	const ACCOUNTS: Record<string, string> = { AKIDDEFAULT: '111111111111', AKIDPROD: '222222222222' };
	let server: Server;
	let endpoint: string;
	let signedWith: string[] = [];

	before(async () => {
		server = createServer((req, res) => {
			const key = /Credential=([^/]+)\//.exec(String(req.headers.authorization))?.[1] ?? '';
			signedWith.push(key);
			req.resume();
			req.on('end', () => {
				const account = ACCOUNTS[key];
				if (!account) {
					res.writeHead(403, { 'content-type': 'text/xml' });
					res.end(
						'<ErrorResponse><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>no</Message></Error><RequestId>1</RequestId></ErrorResponse>',
					);
					return;
				}
				res.writeHead(200, { 'content-type': 'text/xml' });
				res.end(
					`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::${account}:user/u</Arn><UserId>U</UserId><Account>${account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>1</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	/** An AWS config dir: `[default]` signs with AKIDDEFAULT, `[profile prod]` with AKIDPROD. */
	function awsFiles(defaultKey = 'AKIDDEFAULT'): { AWS_CONFIG_FILE: string; AWS_SHARED_CREDENTIALS_FILE: string } {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-cli-aws-'));
		writeFileSync(join(dir, 'config'), '[default]\nregion = us-east-1\n[profile prod]\nregion = us-east-1\n');
		writeFileSync(
			join(dir, 'credentials'),
			`[default]\naws_access_key_id = ${defaultKey}\naws_secret_access_key = secret\n` +
				'[prod]\naws_access_key_id = AKIDPROD\naws_secret_access_key = secret\n',
		);
		return { AWS_CONFIG_FILE: join(dir, 'config'), AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials') };
	}

	/** Run the built `blocks` bin, with only these variables and an empty HOME. */
	async function whoami(root: string, env: NodeJS.ProcessEnv) {
		signedWith = [];
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL('./bin.js', import.meta.url)), 'whoami', '--output', 'json'],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: mkdtempSync(join(tmpdir(), 'blocks-cli-home-')),
					AWS_EC2_METADATA_DISABLED: 'true',
					AWS_ENDPOINT_URL_STS: endpoint,
					AWS_REGION: 'us-east-1',
					...env,
				},
			},
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
		assert.strictEqual(code, 0, stderr);
		return { result: JSON.parse(stdout) as { account: string; credentials: string }, signedWith };
	}

	it('signs with the AWS_PROFILE that .env.production sets, unless the shell exports one', async () => {
		const root = fixtureApp();
		writeFileSync(join(root, '.env.production'), 'AWS_PROFILE=prod\n');
		const files = awsFiles();
		const staged = await whoami(root, files);
		assert.deepStrictEqual(staged.signedWith, ['AKIDPROD']);
		assert.strictEqual(staged.result.account, '222222222222');
		assert.strictEqual(staged.result.credentials, 'AWS profile prod');
		const shell = await whoami(root, { ...files, AWS_PROFILE: 'default' });
		assert.deepStrictEqual(shell.signedWith, ['AKIDDEFAULT']);
		assert.strictEqual(shell.result.account, '111111111111');
	});

	it('reads the AWS config and credentials files that .env.production names', async () => {
		const root = fixtureApp();
		const files = awsFiles('AKIDPROD');
		writeFileSync(
			join(root, '.env.production'),
			`AWS_CONFIG_FILE=${files.AWS_CONFIG_FILE}\nAWS_SHARED_CREDENTIALS_FILE=${files.AWS_SHARED_CREDENTIALS_FILE}\n`,
		);
		const staged = await whoami(root, {});
		assert.deepStrictEqual(staged.signedWith, ['AKIDPROD']);
		assert.strictEqual(staged.result.account, '222222222222');
	});
});

describe('JSON output', () => {
	it('prints whoami as one JSON document', async () => {
		const root = fixtureApp();
		mkdirSync(join(root, '.blocks-sandbox'));
		writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), 'jdoe-abc123');
		const run = await runCli(['whoami', '--output', 'json'], {
			cwd: root,
			core: { readAwsIdentity: async () => IDENTITY },
		});
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(JSON.parse(run.stdout), {
			account: '123456789012',
			arn: 'arn:aws:iam::123456789012:user/dev',
			credentials: 'AWS profile dev',
			region: 'us-east-1',
			projectRoot: root,
			stacks: { sandbox: 'demo-jdoe-abc123', production: 'demo-prod' },
		});
	});

	it('whoami fails cleanly without a Region', async () => {
		const run = await runCli(['whoami'], {
			cwd: fixtureApp(),
			core: { readAwsIdentity: async () => ({ credentials: 'the default credential chain', region: null }) },
		});
		assert.strictEqual(run.code, 1);
		assert.match(run.stderr, /^Error: no AWS Region is set/);
		assert.match(run.stderr, /Try: blocks whoami --region <region>/);
	});

	/** Write `.blocks-sandbox/last-deploy.json`, as the deploy runners do. */
	const writeLastDeploy = (root: string, file: Partial<Record<'production' | 'sandbox', LastDeploy>>) => {
		mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
		writeFileSync(join(root, '.blocks-sandbox', 'last-deploy.json'), JSON.stringify(file));
	};
	const prodUrl = 'https://prod.execute-api.us-east-1.amazonaws.com/';
	const sandboxUrl = 'https://sandbox.execute-api.us-east-1.amazonaws.com/';
	const PROD: LastDeploy = {
		stack: 'demo-prod',
		apiUrl: prodUrl,
		url: 'https://d111.cloudfront.net',
		account: '210987654321',
		region: 'eu-west-3',
		credentials: 'AWS profile prod',
	};
	const SANDBOX: LastDeploy = {
		stack: 'demo-jdoe-abc123',
		apiUrl: sandboxUrl,
		url: null,
		account: '123456789012',
		region: 'us-east-1',
		credentials: 'AWS profile dev',
	};

	it('prints the result the runner recorded, even after another deploy rewrote outputs.json', async () => {
		const root = fixtureApp();
		const lookups: string[] = [];
		const core = {
			readAwsIdentity: async () => {
				lookups.push('readAwsIdentity');
				return IDENTITY;
			},
		};
		const run = await runCli(['deploy', '--output', 'json'], {
			cwd: root,
			env: AWS_ENV,
			core,
			onSpawn: () => {
				writeLastDeploy(root, { production: PROD });
				// After the runner recorded, a sandbox deploy rewrote outputs.json with its own stack
				// only, as CDK does, and a dev server rewrote the shared config.json.
				writeFileSync(
					join(root, '.blocks-sandbox', 'outputs.json'),
					JSON.stringify({ 'demo-jdoe-abc123': { ApiUrl: sandboxUrl } }),
				);
				writeFileSync(
					join(root, '.blocks-sandbox', 'config.json'),
					JSON.stringify({ apiUrl: 'http://localhost:3000/aws-blocks/api', environment: 'local' }),
				);
				return { code: 0 };
			},
		});
		assert.strictEqual(run.code, 0, run.stderr);
		assert.strictEqual(run.spawned[0].stdoutToStderr, true);
		assert.deepStrictEqual(JSON.parse(run.stdout), {
			apiUrl: prodUrl,
			url: 'https://d111.cloudfront.net',
			stack: 'demo-prod',
			account: '210987654321',
			region: 'eu-west-3',
		});
		// The other direction: a production deploy rewrote outputs.json after the sandbox runner recorded.
		const sandbox = await runCli(['sandbox', 'deploy', '--query', 'apiUrl'], {
			cwd: root,
			env: AWS_ENV,
			core,
			onSpawn: () => {
				writeLastDeploy(root, { production: PROD, sandbox: SANDBOX });
				writeFileSync(
					join(root, '.blocks-sandbox', 'outputs.json'),
					JSON.stringify({ 'demo-prod': { ApiUrl: prodUrl } }),
				);
				return { code: 0 };
			},
		});
		assert.strictEqual(sandbox.code, 0, sandbox.stderr);
		assert.strictEqual(sandbox.stdout, `${sandboxUrl}\n`);
		assert.deepStrictEqual(lookups, [], 'the CLI never asks AWS with its own environment');
	});

	it('exits 1 with an error, not null fields, when the runner recorded no result', async () => {
		const root = fixtureApp();
		for (const [argv, operation] of [
			[['deploy', '--query', 'apiUrl'], 'blocks deploy'],
			[['sandbox', 'deploy', '--output', 'json'], 'blocks sandbox deploy'],
		] as const) {
			// The other stage's entry is there; this stage's runner exited 0 and recorded nothing.
			const run = await runCli([...argv], {
				cwd: root,
				env: AWS_ENV,
				onSpawn: () => {
					writeLastDeploy(root, operation === 'blocks deploy' ? { sandbox: SANDBOX } : { production: PROD });
					writeFileSync(
						join(root, '.blocks-sandbox', 'outputs.json'),
						JSON.stringify({
							'demo-prod': { ApiUrl: prodUrl },
							'demo-jdoe-abc123': { ApiUrl: sandboxUrl },
						}),
					);
					return { code: 0 };
				},
			});
			assert.strictEqual(run.code, 1, argv.join(' '));
			assert.strictEqual(run.stdout, '', argv.join(' '));
			assert.match(
				run.stderr,
				new RegExp(
					`^Error: ${operation} finished, but recorded no result in \\.blocks-sandbox[\\\\/]last-deploy\\.json`,
					'm',
				),
			);
		}
	});

	it('prints no result after an interrupted or failed deploy, even with old result files', async () => {
		const root = fixtureApp();
		mkdirSync(join(root, '.blocks-sandbox'));
		writeFileSync(join(root, '.blocks-sandbox', 'config.json'), JSON.stringify({ apiUrl: 'https://old/' }));
		writeFileSync(
			join(root, '.blocks-sandbox', 'outputs.json'),
			JSON.stringify({ 'demo-prod': { ApiUrl: 'https://old/' } }),
		);
		writeLastDeploy(root, { production: PROD, sandbox: SANDBOX });
		const lastDeploy = () => JSON.parse(readFileSync(join(root, '.blocks-sandbox', 'last-deploy.json'), 'utf-8'));
		const lookups: string[] = [];
		const core = {
			readAwsIdentity: async () => {
				lookups.push('readAwsIdentity');
				return IDENTITY;
			},
		};
		for (const [argv, result, code] of [
			[['deploy', '--output', 'json'], { code: null, signal: 'SIGINT' as const, interrupted: true }, 130],
			[['deploy', '--query', 'apiUrl'], { code: 1 }, 1],
			[
				['sandbox', 'deploy', '--output', 'json'],
				{ code: null, signal: 'SIGINT' as const, interrupted: true },
				130,
			],
			[['sandbox', 'deploy', '--query', 'apiUrl'], { code: 1 }, 1],
		] as const) {
			const run = await runCli([...argv], { cwd: root, env: AWS_ENV, core, onSpawn: () => result });
			assert.strictEqual(run.code, code, argv.join(' '));
			assert.strictEqual(run.stdout, '', argv.join(' '));
			// A deploy removes its own stage's stale entry first, and keeps the other's.
			if (argv[0] === 'deploy') assert.deepStrictEqual(lastDeploy(), { sandbox: SANDBOX });
		}
		assert.deepStrictEqual(lookups, []);
		assert.deepStrictEqual(lastDeploy(), {});
	});

	it('prints a --query field raw, for $(...) capture', async () => {
		const root = fixtureApp();
		const run = await runCli(['deploy', '--query', 'apiUrl'], {
			cwd: root,
			env: AWS_ENV,
			core: { readAwsIdentity: async () => IDENTITY },
			onSpawn: () => {
				writeLastDeploy(root, { production: { ...PROD, apiUrl: 'https://api.example/' } });
				return { code: 0 };
			},
		});
		assert.strictEqual(run.code, 0, run.stderr);
		assert.strictEqual(run.stdout, 'https://api.example/\n');
		assert.strictEqual(run.spawned[0].stdoutToStderr, true);

		const nested = await runCli(['whoami', '--query', 'stacks.production'], {
			cwd: root,
			core: { readAwsIdentity: async () => IDENTITY },
		});
		assert.strictEqual(nested.stdout, 'demo-prod\n');
		const missing = await runCli(['whoami', '--query', 'stacks.sandbox'], {
			cwd: root,
			core: { readAwsIdentity: async () => IDENTITY },
		});
		assert.strictEqual(missing.stdout, '\n', 'null prints as an empty line');
	});

	it('rejects an unknown --query field with exit 2, before a deploy runs', async () => {
		const run = await runCli(['deploy', '--query', 'apiURL'], { cwd: fixtureApp(), env: AWS_ENV });
		assert.strictEqual(run.code, 2);
		assert.strictEqual(run.spawned.length, 0);
		assert.match(
			run.stderr,
			/^Error: no field "apiURL" in the result of blocks deploy\. Fields: apiUrl, url, stack, account, region\.\n/,
		);
		const nested = await runCli(['whoami', '--query', 'stacks.prod'], {
			cwd: fixtureApp(),
			core: { readAwsIdentity: async () => IDENTITY },
		});
		assert.strictEqual(nested.code, 2);
		assert.match(nested.stderr, /no field "stacks\.prod" in the result of blocks whoami\. Fields: account, arn,/);
		const noJson = await runCli(['dev', '--query', 'port'], { cwd: fixtureApp() });
		assert.strictEqual(noJson.code, 2);
		assert.match(noJson.stderr, /"blocks dev" has no JSON output to query/);
	});

	it('inherits the child stdout in text mode', async () => {
		const run = await runCli(['deploy'], { cwd: fixtureApp(), env: AWS_ENV });
		assert.strictEqual(run.spawned[0].stdoutToStderr, false);
		assert.strictEqual(run.stdout, '');
	});

	it('sends a real child stdout to stderr when asked', () => {
		const context = pathToFileURL(fileURLToPath(new URL('./context.js', import.meta.url))).href;
		const script = [
			`import { spawnChild } from ${JSON.stringify(context)};`,
			`const r = await spawnChild({ command: process.execPath, args: ['-e', 'console.log("child says hi")'],`,
			`  cwd: process.cwd(), env: process.env, stdoutToStderr: true });`,
			`process.stdout.write(JSON.stringify(r));`,
		].join('\n');
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(JSON.parse(result.stdout), { code: 0, signal: null, interrupted: false });
		assert.match(result.stderr, /child says hi/);
	});
});

describe('the deploy runners record the result', () => {
	const prodUrl = 'https://prod.execute-api.us-east-1.amazonaws.com/';
	const sandboxUrl = 'https://sandbox.execute-api.us-east-1.amazonaws.com/';

	/**
	 * Run a compiled runner in a fresh process with core's deploy steps replaced:
	 * each writes outputs.json as `cdk deploy` does. The production deploy reports
	 * its outputs through `onDeployed`, then, during its liveness wait, a sandbox
	 * deploy of the same app rewrites outputs.json with only its own stack.
	 */
	function runRunner(root: string, runner: RunnerName, options: unknown): void {
		const coreUrl = import.meta.resolve('@aws-blocks/core/scripts');
		const fixture = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { mock } from 'node:test';

const outputs = (stacks) => {
  mkdirSync('.blocks-sandbox', { recursive: true });
  writeFileSync('.blocks-sandbox/outputs.json', JSON.stringify(stacks));
};
// Imports are dynamic: mock.module applies only to modules imported after it.
const real = await import(${JSON.stringify(coreUrl)});
mock.module(${JSON.stringify(coreUrl)}, {
  namedExports: {
    ...real,
    deploy: async (options) => {
      const prod = { ApiUrl: ${JSON.stringify(prodUrl)}, HostingHostingUrl1A2B3C4D: 'https://d111.cloudfront.net' };
      outputs({ 'demo-prod-monitoring': { AlarmTopic: 'arn:topic' }, 'demo-prod': prod });
      options.onDeployed({ stack: 'demo-prod', apiUrl: prod.ApiUrl, hostingUrl: prod.HostingHostingUrl1A2B3C4D });
      outputs({ 'demo-jdoe-abc123': { ApiUrl: ${JSON.stringify(sandboxUrl)} } });
    },
    startSandbox: async () => {
      outputs({ 'demo-jdoe-abc123': { ApiUrl: ${JSON.stringify(sandboxUrl)} } });
      return ${JSON.stringify(sandboxUrl)};
    },
    readAwsIdentity: async () => ({ account: '210987654321', region: 'eu-west-3', credentials: 'AWS profile prod' }),
  },
});
process.argv[2] = ${JSON.stringify(JSON.stringify(options))};
await import(${JSON.stringify(pathToFileURL(runnerPath(runner)).href)});
`;
		const result = spawnSync(
			process.execPath,
			['--experimental-test-module-mocks', '--input-type=module', '-e', fixture],
			{ cwd: root, encoding: 'utf-8', env: { PATH: process.env.PATH, HOME: root }, timeout: 15_000 },
		);
		assert.strictEqual(result.status, 0, result.stderr);
	}

	const lastDeploy = (root: string) =>
		JSON.parse(readFileSync(join(root, '.blocks-sandbox', 'last-deploy.json'), 'utf-8')) as Record<
			string,
			LastDeploy
		>;
	const target = { account: '210987654321', region: 'eu-west-3', credentials: 'AWS profile prod' };

	it('blocks deploy: the outputs core read before its wait, not the outputs.json rewritten during it', () => {
		const root = fixtureApp();
		runRunner(root, 'deploy', { cdkAppPath: join(root, 'aws-blocks', 'index.cdk.ts'), projectRoot: root });
		assert.deepStrictEqual(lastDeploy(root), {
			production: { stack: 'demo-prod', apiUrl: prodUrl, url: 'https://d111.cloudfront.net', ...target },
		});
	});

	it('blocks sandbox deploy: its own stack, next to the production entry', () => {
		const root = fixtureApp();
		mkdirSync(join(root, '.blocks-sandbox'));
		writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), 'jdoe-abc123');
		runRunner(root, 'deploy', { cdkAppPath: join(root, 'aws-blocks', 'index.cdk.ts'), projectRoot: root });
		runRunner(root, 'sandbox', { backendPath: join(root, 'aws-blocks', 'index.cdk.ts'), deployOnly: true });
		assert.deepStrictEqual(lastDeploy(root), {
			production: { stack: 'demo-prod', apiUrl: prodUrl, url: 'https://d111.cloudfront.net', ...target },
			sandbox: { stack: 'demo-jdoe-abc123', apiUrl: sandboxUrl, url: null, ...target },
		});
	});
});
