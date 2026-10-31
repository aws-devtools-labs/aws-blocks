// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type AwsIdentity, describeDeploymentCredentials, runSecretCli } from '@aws-blocks/core/scripts';
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

/** Record a sandbox id in `root`, as the first `blocks sandbox` does; returns `root`. */
function withSandboxId(root: string): string {
	mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
	writeFileSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'), 'jdoe-abc123');
	return root;
}

describe('passthrough commands', () => {
	it('forwards secret and config arguments verbatim, from the project root', async () => {
		const root = fixtureApp();
		const sub = join(root, 'aws-blocks');
		const calls: string[][] = [];
		const argv = ['set', 'API_KEY', '--value-stdin', '--stage', 'production', '--prefix', '/p'];
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

	it('applies the global options after secret, config and db, and never forwards them to the tool', async () => {
		const root = fixtureApp();
		const calls: string[][] = [];
		const record = async (args: string[]) => {
			calls.push(args);
		};
		const core = { runSecretCli: record, runConfigCli: record };
		const config = await runCli(
			['config', 'set', 'K', 'value', '--profile', 'other', '--region=eu-west-1', '-qv'],
			{
				cwd: root,
				core,
			},
		);
		assert.strictEqual(config.code, 0, config.stderr);
		assert.deepStrictEqual(calls.at(-1), ['set', 'K', 'value']);
		assert.strictEqual(config.env.AWS_PROFILE, 'other');
		assert.strictEqual(config.env.AWS_REGION, 'eu-west-1');
		assert.strictEqual(config.env.BLOCKS_LOG_LEVEL, 'verbose');

		const remove = await runCli(['secret', 'remove', 'K', '--profile', 'other', '-C', root], {
			cwd: tmpdir(),
			core,
		});
		assert.strictEqual(remove.code, 0, remove.stderr);
		assert.deepStrictEqual(calls.at(-1), ['remove', 'K']);
		assert.strictEqual(remove.env.AWS_PROFILE, 'other');

		// After `--`, every token is the tool's.
		const literal = await runCli(['config', 'set', 'K', '--', '--profile', '-q'], { cwd: root, core });
		assert.strictEqual(literal.code, 0, literal.stderr);
		assert.deepStrictEqual(calls.at(-1), ['set', 'K', '--', '--profile', '-q']);
		assert.strictEqual(literal.env.AWS_PROFILE, undefined);

		const db = await runCli(['db', 'generate-types', '--no-input', '-y'], { cwd: root });
		assert.strictEqual(db.code, 0, db.stderr);
		assert.deepStrictEqual(db.spawned[0].args.slice(1), ['generate-types']);

		// A bad global option is a usage error before anything runs: never a value, never ignored.
		const callsBefore = calls.length;
		for (const argv of [
			['config', 'list', '--output', 'json'],
			['secret', 'list', '--query', 'keys'],
			['secret', 'list', '--region', 'nowhere'],
			['db', 'status', '--output', 'json'],
			['config', 'set', 'K', 'v', '--profile'],
		]) {
			const run = await runCli(argv, { cwd: root, core });
			assert.strictEqual(run.code, 2, `${argv.join(' ')}: ${run.stderr}`);
			assert.strictEqual(run.spawned.length, 0, argv.join(' '));
		}
		assert.strictEqual(calls.length, callsBefore);
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

	it('resolves the relative paths of db and generate types from the directory the command runs in', async () => {
		const root = fixtureApp();
		const sub = join(root, 'aws-blocks');
		const db = await runCli(['db', 'status', './migrations', '--url', 'postgres://x', '--stage', 's'], {
			cwd: sub,
		});
		assert.strictEqual(db.code, 0, db.stderr);
		assert.deepStrictEqual(db.spawned[0].args.slice(1), [
			'status',
			join(sub, 'migrations'),
			'--url',
			'postgres://x',
			'--stage',
			's',
		]);
		assert.strictEqual(db.spawned[0].cwd, root);
		const types = await runCli(['db', 'generate-types', 'out.ts', '--regenerate-types=gen'], { cwd: sub });
		assert.deepStrictEqual(types.spawned[0].args.slice(1), [
			'generate-types',
			join(sub, 'out.ts'),
			`--regenerate-types=${join(sub, 'gen')}`,
		]);
		// bb-data reads no `--`; the CLI drops the one that ends its own options.
		const dashes = await runCli(['db', 'migrate', '--', 'dir'], { cwd: root });
		assert.deepStrictEqual(dashes.spawned[0].args.slice(1), ['migrate', 'dir']);

		const argvs: string[][] = [];
		const run = await runCli(
			['generate', 'types', '--out', 'mine.d.ts', '--include', '*.ts', '--include', '!skip/**'],
			{
				cwd: sub,
				core: {
					runTypegenCli: async (argv: string[]) => {
						argvs.push(argv);
						return 0;
					},
				},
			},
		);
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(argvs, [
			['--out', join(sub, 'mine.d.ts'), '--include', 'aws-blocks/*.ts', '--include', '!aws-blocks/skip/**'],
		]);
	});

	it('rejects generate types flags that typegen cannot use, as usage errors', async () => {
		const cwd = fixtureApp();
		const argvs: string[][] = [];
		const core = {
			runTypegenCli: async (argv: string[]) => {
				argvs.push(argv);
				return 0;
			},
		};
		for (const [argv, message] of [
			[['--check', '--watch'], /^Error: choose --check or --watch, not both\.\n/],
			[['--out='], /^Error: option --out needs a non-empty value\.\n/],
			[['--include='], /option --include needs a non-empty value/],
			[['--module=', '--out', 'x.d.ts'], /option --module needs a non-empty value/],
		] as const) {
			const run = await runCli(['generate', 'types', ...argv], { cwd, core });
			assert.strictEqual(run.code, 2, argv.join(' '));
			assert.match(run.stderr, message);
		}
		assert.deepStrictEqual(argvs, []);
	});

	it('runs generate client and spec outside an app when the paths are given', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'blocks-cli-outside-'));
		writeFileSync(join(outside, 'backend.ts'), 'export {};\n');
		const client = await runCli(['generate', 'client', 'backend.ts', 'client.js'], { cwd: outside });
		assert.strictEqual(client.code, 0, client.stderr);
		assert.deepStrictEqual(client.spawned[0].args.slice(1), [
			join(outside, 'backend.ts'),
			join(outside, 'client.js'),
		]);
		assert.strictEqual(client.spawned[0].cwd, outside);
		const spec = await runCli(['generate', 'spec', 'backend.ts'], { cwd: outside });
		assert.strictEqual(spec.code, 0, spec.stderr);
		assert.strictEqual(spec.spawned[0].cwd, outside);
		// The defaults are the app's files, so they still need the app.
		for (const argv of [
			['generate', 'client', 'backend.ts'],
			['generate', 'spec'],
		]) {
			const run = await runCli(argv, { cwd: outside });
			assert.strictEqual(run.code, 1, argv.join(' '));
			assert.match(run.stderr, /^Error: not inside an AWS Blocks app/);
		}
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

	it('exits 2 when vendorize gets no package, two packages or an unknown option', async () => {
		const cwd = fixtureApp();
		for (const [argv, message] of [
			[
				['vendorize'],
				/^Error: "blocks vendorize" needs the <package> argument\.\nTry: blocks vendorize --help\n$/,
			],
			[['vendorize', '--force'], /needs the <package> argument/],
			[['vendorize', 'a', 'b'], /unexpected argument "b" for "blocks vendorize"/],
			[['vendorize', 'a', '-x'], /unknown option "-x" for "blocks vendorize"; it takes only --force/],
		] as const) {
			const run = await runCli([...argv], { cwd });
			assert.strictEqual(run.code, 2, argv.join(' '));
			assert.match(run.stderr, message);
			assert.strictEqual(run.spawned.length, 0, argv.join(' '));
		}
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
				invocation: 'blocks sandbox',
				destroyInvocation: 'blocks sandbox destroy',
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
		const root = withSandboxId(fixtureApp());
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
			invocation: 'blocks sandbox destroy',
		});
		assert.match(run.stderr, /production stack is not affected/);
		assert.deepStrictEqual(run.prompts, []);
	});

	it('deletes nothing and creates no sandbox id when this machine has none', async () => {
		const root = fixtureApp();
		for (const argv of [['sandbox', 'destroy'], ['sandbox', 'destroy', '--yes']]) {
			const run = await runCli(argv, { cwd: root, env: AWS_ENV, stdinIsTTY: true });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.deepStrictEqual(run.spawned, []);
			assert.deepStrictEqual(run.prompts, []);
			assert.match(run.stdout, /^No sandbox on this machine \(\.blocks-sandbox\/sandbox-id\.txt is missing\); nothing to delete\./);
			assert.doesNotMatch(run.stdout, /destroyed/);
			assert.ok(!existsSync(join(root, '.blocks-sandbox', 'sandbox-id.txt')));
		}
	});

	it('forwards --wait-live as core reads it from argv', async () => {
		const root = fixtureApp();
		const run = await runCli(['deploy', '--wait-live=30'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		const [spec] = run.spawned;
		assert.deepStrictEqual(runnerOptions(spec, 'deploy'), {
			cdkAppPath: join(root, 'aws-blocks', 'index.cdk.ts'),
			projectRoot: root,
			invocation: 'blocks deploy',
		});
		assert.deepStrictEqual(spec.args.slice(-2), ['--wait-live', '--wait-live-timeout=30']);
		assert.match(run.stderr, /Deploying the production stack demo-prod; Region us-east-1/);
	});

	it("passes core the command that re-runs this one, with the run's -C, --profile and --region", async () => {
		const root = withSandboxId(fixtureApp());
		const shell = mkdtempSync(join(tmpdir(), 'blocks-cli-shell-'));
		const app = join(shell, 'my app');
		cpSync(root, app, { recursive: true });
		const globals = ['-C', 'my app', '--profile', 'prod', '--region', 'eu-west-1'];
		const suffix = "-C 'my app' --profile prod --region eu-west-1";
		for (const [argv, runner, expected] of [
			[['deploy'], 'deploy', { invocation: `blocks deploy ${suffix}` }],
			[['destroy', '--yes'], 'destroy', { invocation: `blocks destroy ${suffix}` }],
			[['sandbox', 'destroy'], 'sandbox-destroy', { invocation: `blocks sandbox destroy ${suffix}` }],
			[
				['sandbox', 'deploy'],
				'sandbox',
				{ invocation: `blocks sandbox deploy ${suffix}`, destroyInvocation: `blocks sandbox destroy ${suffix}` },
			],
		] as const) {
			const run = await runCli([...globals, ...argv], { cwd: shell });
			assert.strictEqual(run.code, 0, run.stderr);
			const options = runnerOptions(run.spawned[0], runner) as Record<string, unknown>;
			for (const [key, value] of Object.entries(expected)) assert.strictEqual(options[key], value, argv.join(' '));
		}
		const seen: string[] = [];
		await runCli(['--profile', 'prod', 'whoami'], {
			cwd: root,
			env: AWS_ENV,
			core: { readAwsIdentity: async ({ invocation }) => (seen.push(invocation), IDENTITY) },
		});
		assert.deepStrictEqual(seen, ['blocks whoami --profile prod']);
	});

	it('checks the --wait-live budget before anything runs, and passes core one budget', async () => {
		const root = fixtureApp();
		for (const [argv, expected] of [
			[['--wait-live'], ['--wait-live']],
			[['--wait-live', '--wait-live-timeout=3600'], ['--wait-live', '--wait-live-timeout=3600']],
			[['--wait-live', '--wait-live-timeout', '1'], ['--wait-live', '--wait-live-timeout=1']],
		] as const) {
			const run = await runCli(['deploy', ...argv], { cwd: root, env: AWS_ENV });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.deepStrictEqual(run.spawned[0].args.slice(-expected.length), expected, argv.join(' '));
			assert.strictEqual(run.spawned[0].args.filter((arg) => arg.startsWith('--wait-live')).length, expected.length);
		}
		for (const [argv, message] of [
			[['--wait-live=0'], /option --wait-live must be a whole number of seconds from 1 to 3600, not "0"\./],
			[['--wait-live=abc'], /option --wait-live must be .*, not "abc"\./],
			[['--wait-live=-5'], /option --wait-live must be .*, not "-5"\./],
			[['--wait-live=3601'], /not "3601"/],
			[['--wait-live=1.5'], /not "1\.5"/],
			[['--wait-live='], /not ""/],
			[['--wait-live', '--wait-live-timeout=abc'], /option --wait-live-timeout must be .*, not "abc"\./],
			[['--wait-live-timeout=20'], /option --wait-live-timeout needs --wait-live\.\n(.*\n)*Try: blocks deploy --wait-live=20\n/],
			[['--wait-live=10', '--wait-live-timeout=20'], /give the --wait-live budget once/],
		] as const) {
			const run = await runCli(['deploy', ...argv], { cwd: root, env: AWS_ENV });
			assert.strictEqual(run.code, 2, argv.join(' '));
			assert.deepStrictEqual(run.spawned, [], argv.join(' '));
			assert.match(run.stderr, message, argv.join(' '));
			assert.doesNotMatch(run.stderr, /Deploying/, argv.join(' '));
		}
	});

	it('opens the console for the sandbox stack in its deployed Region, never the production stack', async () => {
		const opened: unknown[] = [];
		const core = { openConsole: async (options: unknown) => void opened.push(options) };
		const root = withSandboxId(fixtureApp());
		const sandboxFile = join(root, '.blocks-sandbox');
		// A production deploy after the sandbox deploy left only its own stack in outputs.json.
		writeFileSync(join(sandboxFile, 'outputs.json'), JSON.stringify({ 'demo-prod': { ApiUrl: 'https://p' } }));
		const last: Partial<LastDeploy> = { stack: 'demo-jdoe-abc123', apiUrl: 'https://s', url: null, region: 'eu-west-1' };
		writeFileSync(join(sandboxFile, 'last-deploy.json'), JSON.stringify({ sandbox: last }));
		const recorded = await runCli(['sandbox', 'console', '--region', 'us-west-2'], { cwd: root, core });
		assert.strictEqual(recorded.code, 0, recorded.stderr);
		assert.deepStrictEqual(opened.pop(), { stackId: 'demo-jdoe-abc123', region: 'eu-west-1' });
		// Watch mode records no result: the sandbox's own outputs and its stage Region.
		rmSync(join(sandboxFile, 'last-deploy.json'));
		writeFileSync(join(sandboxFile, 'outputs.json'), JSON.stringify({ 'demo-jdoe-abc123': { ApiUrl: 'https://s' } }));
		writeFileSync(join(root, '.env.local'), 'AWS_REGION=ap-south-1\n');
		const watch = await runCli(['sandbox', 'console'], { cwd: root, core });
		assert.strictEqual(watch.code, 0, watch.stderr);
		assert.deepStrictEqual(opened.pop(), { stackId: 'demo-jdoe-abc123', region: 'ap-south-1' });
		// Nothing recorded for the sandbox, or no sandbox at all: exit 1, nothing opened.
		writeFileSync(join(sandboxFile, 'outputs.json'), JSON.stringify({ 'demo-prod': { ApiUrl: 'https://p' } }));
		const none = await runCli(['sandbox', 'console'], { cwd: root, core });
		assert.strictEqual(none.code, 1);
		assert.match(none.stderr, /^Error: no deploy of the sandbox stack demo-jdoe-abc123 is recorded on this machine\.\n(.*\n)*Try: blocks sandbox deploy\n/);
		const noId = await runCli(['sandbox', 'console'], { cwd: fixtureApp(), core });
		assert.strictEqual(noId.code, 1);
		assert.match(noId.stderr, /^Error: no sandbox on this machine/);
		assert.deepStrictEqual(opened, []);
	});

	it('forgets the deleted sandbox in last-deploy.json, outputs.json and config.json, and keeps the rest', async () => {
		const root = withSandboxId(fixtureApp());
		const dir = join(root, '.blocks-sandbox');
		const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
		const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8')) as unknown;
		const entry = (stack: string) => ({ stack, apiUrl: 'https://a', url: null, account: null, region: 'us-east-1', credentials: 'x' });
		const seed = (config: unknown) => {
			write('last-deploy.json', { sandbox: entry('demo-jdoe-abc123'), production: entry('demo-prod') });
			write('outputs.json', { 'demo-jdoe-abc123': { ApiUrl: 'https://s' }, 'demo-prod': { ApiUrl: 'https://p' } });
			write('config.json', config);
		};
		seed({ apiUrl: 'https://s', environment: 'sandbox' });
		// A failed destroy forgets nothing.
		const failed = await runCli(['sandbox', 'destroy'], { cwd: root, env: AWS_ENV, onSpawn: () => ({ code: 1 }) });
		assert.strictEqual(failed.code, 1);
		assert.deepStrictEqual(Object.keys(read('outputs.json') as object), ['demo-jdoe-abc123', 'demo-prod']);
		const run = await runCli(['sandbox', 'destroy'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(Object.keys(read('last-deploy.json') as object), ['production']);
		assert.deepStrictEqual(read('outputs.json'), { 'demo-prod': { ApiUrl: 'https://p' } });
		assert.ok(!existsSync(join(dir, 'config.json')));
		assert.ok(existsSync(join(dir, 'sandbox-id.txt')));
		const console = await runCli(['sandbox', 'console'], { cwd: root, core: { openConsole: async () => {} } });
		assert.strictEqual(console.code, 1);
		// A production config.json stays; an outputs.json with only the sandbox goes.
		seed({ apiUrl: 'https://p', environment: 'production' });
		write('outputs.json', { 'demo-jdoe-abc123': { ApiUrl: 'https://s' } });
		assert.strictEqual((await runCli(['sandbox', 'destroy'], { cwd: root, env: AWS_ENV })).code, 0);
		assert.deepStrictEqual(read('config.json'), { apiUrl: 'https://p', environment: 'production' });
		assert.ok(!existsSync(join(dir, 'outputs.json')));
	});

	it('refuses a project telemetry change outside an app, and reads status from the -C directory', async () => {
		const shell = mkdtempSync(join(tmpdir(), 'blocks-cli-shell-'));
		const other = mkdtempSync(join(tmpdir(), 'blocks-cli-other-'));
		const seen: string[][] = [];
		const core = {
			telemetry: async (options?: { argv?: string[] }) => {
				seen.push(options?.argv ?? []);
			},
		};
		const disable = await runCli(['-C', other, 'telemetry', 'disable'], { cwd: shell, core });
		assert.strictEqual(disable.code, 2);
		assert.match(
			disable.stderr,
			/^Error: not inside an AWS Blocks app, so there is no project to disable telemetry for\./,
		);
		assert.deepStrictEqual(seen, []);
		const status = await runCli(['-C', other, 'telemetry'], { cwd: shell, core });
		assert.strictEqual(status.code, 0, status.stderr);
		assert.deepStrictEqual(status.chdirs, [other]);
		const global = await runCli(['telemetry', 'disable', '--global'], { cwd: shell, core });
		assert.strictEqual(global.code, 0, global.stderr);
		assert.deepStrictEqual(seen, [
			['node', 'blocks', '--status'],
			['node', 'blocks', '--disable', '--global'],
		]);
	});

	it('makes --telemetry-file absolute in the argv that in-process core functions read', async () => {
		const root = fixtureApp();
		const shell = mkdtempSync(join(tmpdir(), 'blocks-cli-shell-'));
		const core = { telemetry: async () => {} };
		for (const [argv, expected] of [
			[
				['-C', root, '--telemetry-file', 'rel.json', 'telemetry'],
				['-C', root, '--telemetry-file', join(shell, 'rel.json'), 'telemetry'],
			],
			[
				['-C', root, 'telemetry', '--telemetry-file=rel.json'],
				['-C', root, 'telemetry', `--telemetry-file=${join(shell, 'rel.json')}`],
			],
		] as const) {
			const run = await runCli([...argv], { cwd: shell, core });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.deepStrictEqual(run.argv, ['node', 'blocks', ...expected]);
		}
	});

	it('forwards --telemetry-file to every runner as core reads it, in either form and position', async () => {
		const root = withSandboxId(fixtureApp());
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
		const deploy = await runCli(['deploy', '--wait-live', '--telemetry-file=events.json'], {
			cwd: root,
			env: AWS_ENV,
		});
		assert.strictEqual(deploy.code, 0, deploy.stderr);
		assert.deepStrictEqual(deploy.spawned[0].args.slice(-2), ['--wait-live', `--telemetry-file=${file}`]);
		const sandbox = await runCli(['sandbox', 'destroy', '--telemetry-file=events.json'], {
			cwd: root,
			env: AWS_ENV,
		});
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
		assert.strictEqual(run.spawned[0].longRunning, false);
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
		const inherited = await runCli(['dev', '--host', '0.0.0.0'], {
			cwd: root,
			env: { BLOCKS_DEV_HOST: 'mybox.example.com' },
		});
		assert.strictEqual(inherited.spawned[0].env.BLOCKS_DEV_HOST, 'mybox.example.com');
		const configured = fixtureApp({ blocks: { dev: { host: '0.0.0.0' } } });
		const sandbox = await runCli(['sandbox'], {
			cwd: configured,
			env: { ...AWS_ENV, BLOCKS_DEV_HOST: 'mybox.example.com' },
		});
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
			[{ code: 1, interrupted: true }, 130],
		] as const) {
			const run = await runCli(['vendorize', 'x'], { cwd, onSpawn: () => result });
			assert.strictEqual(run.code, expected, JSON.stringify(result));
		}
		const failed = await runCli(['vendorize', 'x'], { cwd, onSpawn: () => ({ code: 7 }) });
		assert.match(
			failed.stderr,
			/^Error: blocks vendorize failed: blocks-vendorize exited with code 7; its output is above\.\n {2}project: /,
		);
		// The child finished its work before a Ctrl-C reached it: that is the result, not an interruption.
		const finished = await runCli(['db', 'migrate'], { cwd, onSpawn: () => ({ code: 0, interrupted: true }) });
		assert.strictEqual(finished.code, 0);
		assert.match(finished.stderr, /blocks db migrate finished before the interrupt stopped it\./);
		// A long-running child exits 0 when Ctrl-C stops it: that is an interruption.
		const dev = await runCli(['dev'], { cwd, onSpawn: () => ({ code: 0, interrupted: true }) });
		assert.strictEqual(dev.code, 130);
	});

	it('fails blocks dev with the reason its runner recorded, and takes a 143 without one as a requested stop', async () => {
		const cwd = fixtureApp();
		const failed = await runCli(['dev'], {
			cwd,
			onSpawn: (spec) => {
				writeFileSync(
					String(spec.env.BLOCKS_DEV_FAILURE_FILE),
					'dev server already running on :3000 (pid 42)\n',
				);
				return { code: 143 };
			},
		});
		assert.strictEqual(failed.code, 1);
		assert.match(failed.stderr, /^Error: blocks dev failed: dev server already running on :3000 \(pid 42\)\.\n/);
		assert.doesNotMatch(failed.stderr, /--verbose/);
		// `blocks dev stop`, or a SIGTERM to the CLI, while the backend had crashed: tsx watch exits 143.
		const stopped = await runCli(['dev'], { cwd, onSpawn: () => ({ code: 143 }) });
		assert.strictEqual(stopped.code, 0, stopped.stderr);
		assert.strictEqual(stopped.stderr, '');
		// Other commands keep mapping 143 to a failure.
		assert.strictEqual((await runCli(['vendorize', 'x'], { cwd, onSpawn: () => ({ code: 143 }) })).code, 1);
	});

	it('runs only the watch runners, dev and sandbox, as long-running children', async () => {
		const cwd = withSandboxId(fixtureApp());
		for (const [argv, longRunning] of [
			[['dev'], true],
			[['sandbox'], true],
			[['sandbox', 'deploy'], false],
			[['sandbox', 'destroy'], false],
			[['deploy'], false],
			[['destroy', '--yes'], false],
		] as const) {
			const run = await runCli([...argv], { cwd, env: AWS_ENV });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.strictEqual(run.spawned[0].longRunning ?? false, longRunning, argv.join(' '));
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
		const alias = await runCli(['help', 'typegn'], { cwd });
		assert.match(alias.stderr, /unknown command "typegn"\. Did you mean "generate types"\?/);
	});

	it('shows the help of a db, secret or config verb outside an app', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'blocks-cli-outside-'));
		const calls: string[][] = [];
		const record = async (args: string[]) => {
			calls.push(args);
		};
		const core = { runSecretCli: record, runConfigCli: record };
		for (const argv of [
			['secret', 'set', '-h'],
			['help', 'secret', 'remove'],
			['config', 'list', '--help'],
		]) {
			const run = await runCli(argv, { cwd: outside, core });
			assert.strictEqual(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
			assert.deepStrictEqual(run.chdirs, [], argv.join(' '));
		}
		assert.deepStrictEqual(calls, [
			['set', '--help'],
			['remove', '--help'],
			['list', '--help'],
		]);
		for (const argv of [
			['db', 'migrate', '--help'],
			['help', 'db', 'pull'],
		]) {
			const run = await runCli(argv, { cwd: outside });
			assert.strictEqual(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
			assert.match(run.spawned[0].args[0], /bb-data[\\/]dist[\\/]cli\.js$/);
			assert.strictEqual(run.spawned[0].cwd, outside);
		}
		// Running a verb still needs the app.
		const run = await runCli(['secret', 'list'], { cwd: outside, core });
		assert.strictEqual(run.code, 1);
		assert.match(run.stderr, /^Error: not inside an AWS Blocks app/);
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
		const cwd = withSandboxId(fixtureApp());
		for (const argv of [['destroy'], ['sandbox', 'destroy']]) {
			const run = await runCli(argv, { cwd, env: AWS_ENV, stdinIsTTY: true, answer: null });
			assert.strictEqual(run.code, 130, argv.join(' '));
			assert.strictEqual(run.prompts.length, 1, argv.join(' '));
			assert.strictEqual(run.spawned.length, 0, argv.join(' '));
			assert.match(run.stderr, /Interrupted; nothing was deleted\.\n$/);
		}
	});

	it('runs with --yes and no prompt, naming the stack it expects to delete', async () => {
		const root = fixtureApp();
		const run = await runCli(['destroy', '--yes'], { cwd: root, env: AWS_ENV });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(run.prompts, []);
		assert.strictEqual(run.spawned.length, 1);
		// Core refuses when the CDK app does not define this stack, and says "nothing to delete" when it does not exist.
		assert.deepStrictEqual(runnerOptions(run.spawned[0], 'destroy'), {
			cdkAppPath: join(root, 'aws-blocks', 'index.cdk.ts'),
			projectRoot: root,
			stackName: 'demo-prod',
			invocation: 'blocks destroy',
		});
	});

	it('says when CDK deployed another stack than the one .blocks/config.json names', async () => {
		const root = fixtureApp();
		const record = (stack: string) => () => {
			mkdirSync(join(root, '.blocks-sandbox'), { recursive: true });
			const entry: LastDeploy = { stack, apiUrl: 'https://a', url: null, account: null, region: 'us-east-1', credentials: 'x' };
			writeFileSync(join(root, '.blocks-sandbox', 'last-deploy.json'), JSON.stringify({ production: entry }));
			return undefined;
		};
		const other = await runCli(['-q', 'deploy'], { cwd: root, env: AWS_ENV, onSpawn: record('my-blocks-stack-prod') });
		assert.strictEqual(other.code, 0, other.stderr);
		assert.match(
			other.stderr,
			/Warning: CDK deployed the stack my-blocks-stack-prod, not demo-prod, which \.blocks\/config\.json names\.\n.*so that <stackId>-prod is my-blocks-stack-prod\./,
		);
		const same = await runCli(['deploy'], { cwd: root, env: AWS_ENV, onSpawn: record('demo-prod') });
		assert.doesNotMatch(same.stderr, /Warning/);
	});

	it('without a stackId, says <id>-prod must be the existing production stack, with a Try line', async () => {
		const root = fixtureApp();
		writeFileSync(join(root, '.blocks', 'config.json'), '{}');
		for (const argv of [['deploy'], ['destroy', '--yes']]) {
			const run = await runCli(argv, { cwd: root, env: AWS_ENV });
			assert.strictEqual(run.code, 1, argv.join(' '));
			assert.deepStrictEqual(run.spawned, []);
			assert.match(run.stderr, /<id>-prod must be the name of its existing production stack/);
			assert.match(run.stderr, /\nTry: aws cloudformation describe-stacks --query "Stacks\[\?ends_with\(StackName, '-prod'\)\]\.StackName"\n/);
		}
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
			['-q', 'whoami'],
		]) {
			const run = await runCli(argv, {
				cwd,
				env: { ...AWS_ENV, ...keys },
				core: { readAwsIdentity: async () => ({ ...IDENTITY, credentials: 'access keys in AWS_ACCESS_KEY_ID' }) },
			});
			assert.match(run.stderr, /Warning: access keys in the environment are set/, argv.join(' '));
		}
		// A profile alone is named as the profile, with no warning.
		const profile = await runCli(['destroy', '--yes'], { cwd, env: { ...AWS_ENV, AWS_PROFILE: 'dev' } });
		assert.match(profile.stderr, /credentials: AWS profile dev/);
		assert.doesNotMatch(profile.stderr, /Warning/);
	});

	it('uses an explicit --profile instead of the access keys in the environment, in every command', async () => {
		const keys = { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token' };
		const cwd = fixtureApp();
		// A stage env file cannot bring the keys back either.
		writeFileSync(join(cwd, '.env.production'), 'AWS_ACCESS_KEY_ID=AKIAFILE\nAWS_SECRET_ACCESS_KEY=file\n');
		const seen: NodeJS.ProcessEnv[] = [];
		const core = {
			readAwsIdentity: async ({ env, projectRoot }: { env?: NodeJS.ProcessEnv; projectRoot?: string }) => {
				seen.push({ ...env });
				const target = await describeDeploymentCredentials({ env, projectRoot });
				return { credentials: target.credentials, region: target.region, account: '123456789012' };
			},
		};
		for (const argv of [['destroy', '--yes'], ['deploy'], ['whoami']]) {
			const run = await runCli(['--profile', 'prod', ...argv], { cwd, env: { ...AWS_ENV, ...keys }, core });
			assert.strictEqual(run.code, 0, run.stderr);
			assert.match(run.stdout + run.stderr, /credentials: AWS profile prod|Credentials: AWS profile prod/, argv.join(' '));
			assert.doesNotMatch(run.stderr, /access keys in the environment are set/, argv.join(' '));
			assert.match(
				run.stderr,
				/Warning: --profile prod is given, so this run ignores AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN\./,
			);
			const env = run.spawned[0]?.env ?? seen.at(-1) ?? {};
			assert.deepStrictEqual(
				[env.AWS_PROFILE, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN],
				['prod', '', '', ''],
				argv.join(' '),
			);
		}
		// Without keys in the environment there is nothing to say.
		const plain = await runCli(['--profile', 'prod', 'deploy'], { cwd: fixtureApp(), env: AWS_ENV });
		assert.doesNotMatch(plain.stderr, /Warning/);
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
		assert.match(run.stderr, /> .*migrate 'postgres:\/\/admin:\*\*\*@db\.example\.com\/app' --url '\*\*\*'/);
		assert.doesNotMatch(run.stderr, /hunter2|u:pw/);
		// The child still gets the real arguments.
		assert.deepStrictEqual(run.spawned[0].args.slice(-3), [
			'postgres://admin:hunter2@db.example.com/app',
			'--url',
			'postgres://u:pw@h/db',
		]);
	});

	it('quotes the words of the echoed command line that a shell would split', async () => {
		const root = join(fixtureApp(), 'app x');
		mkdirSync(join(root, 'aws-blocks'), { recursive: true });
		writeFileSync(join(root, 'package.json'), '{}');
		writeFileSync(join(root, 'aws-blocks', 'index.ts'), 'export {};\n');
		const run = await runCli(['-v', 'generate', 'spec'], { cwd: root });
		assert.strictEqual(run.code, 0, run.stderr);
		const options = JSON.stringify({
			backendPath: join(root, 'aws-blocks', 'index.ts'),
			outputPath: join(root, 'aws-blocks', 'blocks.spec.json'),
		});
		assert.ok(run.stderr.includes(` '${options}'`), run.stderr);
		assert.doesNotMatch(run.stderr, / \{"backendPath"/);
	});
});

describe('error format', () => {
	it('offers --verbose only after a runner, and --debug only when there is a stack trace', async () => {
		const root = fixtureApp();
		const runner = await runCli(['deploy'], { cwd: root, env: AWS_ENV, onSpawn: () => ({ code: 1 }) });
		assert.strictEqual(runner.code, 1);
		assert.match(
			runner.stderr,
			/\nError: blocks deploy failed \(exit code 1\)\.\n(.*\n)*Run with --verbose for the full tool output, or --debug for a stack trace\.\n$/,
		);
		// A tool such as bb-data printed its own error; the CLI names it, and --verbose adds nothing.
		const tool = await runCli(['db', 'status'], { cwd: root, onSpawn: () => ({ code: 1 }) });
		assert.strictEqual(tool.code, 1);
		assert.strictEqual(
			tool.stderr,
			`Error: blocks db status failed: bb-data exited with code 1; its output is above.\n  project: ${root}\n`,
		);
		// An error the CLI raised itself: no hint, and --debug shows where it came from.
		const outside = mkdtempSync(join(tmpdir(), 'blocks-cli-outside-'));
		const plain = await runCli(['generate', 'spec'], { cwd: outside });
		assert.strictEqual(plain.code, 1);
		assert.doesNotMatch(plain.stderr, /Run with/);
		const debug = await runCli(['generate', 'spec', '--debug'], { cwd: outside });
		assert.match(debug.stderr, /^Error: not inside an AWS Blocks app[\s\S]*\n {4}at /);
		// An underlying error has a stack to show.
		const cause = await runCli(['secret', 'list'], {
			cwd: root,
			core: {
				runSecretCli: async () => {
					throw new Error('AccessDenied');
				},
			},
		});
		assert.match(cause.stderr, /^Error: AccessDenied\nRun with --debug for a stack trace\.\n$/);
	});

	it('prints a runner error without its stack trace, unless --debug', () => {
		const fail = pathToFileURL(fileURLToPath(new URL('./runners/fail.js', import.meta.url))).href;
		const script = `import { exitWithError } from ${JSON.stringify(fail)}; exitWithError(new Error('boom'));`;
		for (const [level, stack] of [
			['normal', false],
			['debug', true],
		] as const) {
			const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
				env: { ...process.env, BLOCKS_LOG_LEVEL: level },
				encoding: 'utf-8',
			});
			assert.strictEqual(child.status, 1, child.stderr);
			assert.match(child.stderr, /^❌ boom\n/);
			assert.strictEqual(/\n {4}at /.test(child.stderr), stack, child.stderr);
		}
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

	it('resolves the same target for destroy, deploy and whoami in every precedence combination', async () => {
		const whoamiCore = {
			readAwsIdentity: async ({ env, projectRoot }: { env?: NodeJS.ProcessEnv; projectRoot?: string }) => {
				const target = await describeDeploymentCredentials({ env, projectRoot });
				return { credentials: target.credentials, region: target.region, account: '123456789012' };
			},
		};
		const cases: { name: string; file?: string; env?: NodeJS.ProcessEnv; flags?: string[]; expected: string }[] = [
			{
				name: 'shell only',
				env: { AWS_REGION: 'us-east-1' },
				expected: 'Region us-east-1, credentials: the default credential chain',
			},
			{
				name: '.env.production only',
				file: 'AWS_PROFILE=prod\nAWS_REGION=eu-west-2\n',
				expected: 'Region eu-west-2, credentials: AWS profile prod',
			},
			{
				name: 'an exported Region and profile win over the file',
				file: 'AWS_PROFILE=prod\nAWS_REGION=eu-west-2\n',
				env: { AWS_PROFILE: 'shell', AWS_REGION: 'us-west-1' },
				expected: 'Region us-west-1, credentials: AWS profile shell',
			},
			{
				name: '--profile and --region win over the shell and the file',
				file: 'AWS_PROFILE=prod\nAWS_REGION=eu-west-2\n',
				env: { AWS_PROFILE: 'shell', AWS_REGION: 'us-west-1' },
				flags: ['--profile', 'flag', '--region', 'ap-south-1'],
				expected: 'Region ap-south-1, credentials: AWS profile flag',
			},
			{
				name: 'the file Region with --profile',
				file: 'AWS_REGION=eu-west-2\n',
				flags: ['--profile', 'flag'],
				expected: 'Region eu-west-2, credentials: AWS profile flag',
			},
			{
				name: 'AWS_DEFAULT_REGION and AWS_DEFAULT_PROFILE from the file',
				file: 'AWS_DEFAULT_PROFILE=prod\nAWS_DEFAULT_REGION=eu-north-1\n',
				expected: 'Region eu-north-1, credentials: AWS profile prod',
			},
		];
		for (const { name, file, env, flags = [], expected } of cases) {
			const root = fixtureApp();
			if (file !== undefined) writeFileSync(join(root, '.env.production'), file);
			const destroy = await runCli([...flags, 'destroy', '--yes'], { cwd: root, env });
			assert.strictEqual(destroy.code, 0, `${name}: ${destroy.stderr}`);
			assert.ok(destroy.stderr.includes(`This deletes the production stack demo-prod; ${expected};`), `${name}: ${destroy.stderr}`);
			const deploy = await runCli([...flags, 'deploy'], { cwd: root, env });
			assert.ok(deploy.stderr.includes(`Deploying the production stack demo-prod; ${expected};`), `${name}: ${deploy.stderr}`);
			const whoami = await runCli([...flags, 'whoami', '--output', 'json'], { cwd: root, env, core: whoamiCore });
			assert.strictEqual(whoami.code, 0, `${name}: ${whoami.stderr}`);
			const { region, credentials } = JSON.parse(whoami.stdout) as { region: string; credentials: string };
			assert.strictEqual(`Region ${region}, credentials: ${credentials}`, expected, name);
		}
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
			// SigV4: `Credential=<access key>/<scope>`; read the key without a regex over the header.
			const authorization = String(req.headers.authorization);
			const start = authorization.indexOf('Credential=');
			const credential = start === -1 ? '' : authorization.slice(start + 'Credential='.length);
			const slash = credential.indexOf('/');
			const key = slash === -1 ? '' : credential.slice(0, slash);
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
	async function whoami(root: string, env: NodeJS.ProcessEnv, args: string[] = []) {
		signedWith = [];
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL('./bin.js', import.meta.url)), ...args, 'whoami', '--output', 'json'],
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

	it('signs with an explicit --profile, not with the access keys in the environment', async () => {
		const keys = { AWS_ACCESS_KEY_ID: 'AKIDDEFAULT', AWS_SECRET_ACCESS_KEY: 'secret' };
		const flag = await whoami(fixtureApp(), { ...awsFiles(), ...keys }, ['--profile', 'prod']);
		assert.deepStrictEqual(flag.signedWith, ['AKIDPROD']);
		assert.strictEqual(flag.result.account, '222222222222');
		assert.strictEqual(flag.result.credentials, 'AWS profile prod');
		// An exported AWS_PROFILE loses to the keys, as it does in CDK.
		const exported = await whoami(fixtureApp(), { ...awsFiles(), ...keys, AWS_PROFILE: 'prod' });
		assert.deepStrictEqual(exported.signedWith, ['AKIDDEFAULT']);
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

	it('whoami tells a malformed .blocks/config.json from a missing one or a missing stackId', async () => {
		const root = fixtureApp();
		const core = { readAwsIdentity: async () => IDENTITY };
		const config = join(root, '.blocks', 'config.json');
		writeFileSync(config, '{bad json');
		const bad = await runCli(['whoami'], { cwd: root, core });
		assert.strictEqual(bad.code, 0, bad.stderr);
		assert.match(bad.stdout, /Production: {2}\(invalid \.blocks\/config\.json\)/);
		assert.match(bad.stderr, /Warning: \.blocks\/config\.json is not valid JSON/);
		const deploy = await runCli(['deploy'], { cwd: root, env: AWS_ENV });
		assert.match(deploy.stderr, /^Error: \.blocks\/config\.json is not valid JSON/);
		assert.doesNotMatch(deploy.stderr, /Try:/);
		writeFileSync(config, '{}');
		assert.match((await runCli(['whoami'], { cwd: root, core })).stdout, /\(no stackId in \.blocks\/config\.json\)/);
		rmSync(config);
		assert.match((await runCli(['whoami'], { cwd: root, core })).stdout, /\(no \.blocks\/config\.json\)/);
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
		// The whole path is checked before the command runs: a nested typo never repeats a deploy or stops a server.
		const identities: unknown[] = [];
		const stops: number[] = [];
		const core = {
			readAwsIdentity: async () => {
				identities.push(1);
				return IDENTITY;
			},
			stopDevServer: async (port = 3000) => {
				stops.push(port);
				return {
					port,
					stopped: true,
					alreadyStopped: false,
					portFree: true,
					record: null,
					pids: [],
					via: 'watcher' as const,
				};
			},
		};
		for (const [argv, message] of [
			[['whoami', '--query', 'stacks.prod'], 'Fields of stacks: sandbox, production.'],
			[['deploy', '--query', 'apiUrl.x'], 'apiUrl is a value, with no fields.'],
			[
				['dev', 'stop', '--query', 'stopped.0.nope'],
				'Fields of stopped.0: port, stopped, alreadyStopped, portFree, via.',
			],
			[
				['dev', 'stop', '--query', 'stopped.length'],
				'stopped is a list; name an element by its index, as stopped.0.',
			],
			[
				['dev', 'stop', '--query', 'stopped.01'],
				'stopped is a list; name an element by its index, as stopped.0.',
			],
		] as const) {
			const nested = await runCli([...argv], { cwd: fixtureApp(), env: AWS_ENV, core });
			assert.strictEqual(nested.code, 2, argv.join(' '));
			const path = argv[argv.length - 1].replace(/\./g, '\\.');
			assert.match(
				nested.stderr,
				new RegExp(
					`^Error: no field "${path}" in the result of blocks ${argv[0]}[^.]*\\. ${message.replace(/\./g, '\\.')}\\n`,
				),
			);
			assert.strictEqual(nested.spawned.length, 0, argv.join(' '));
		}
		assert.deepStrictEqual(identities, []);
		assert.deepStrictEqual(stops, []);
		// A valid path whose element is absent prints an empty line, after the command did its work.
		const root = fixtureApp();
		const port = await runCli(['dev', 'stop', '--port', '41999', '--query', 'stopped.0.port'], { cwd: root, core });
		assert.strictEqual(port.code, 0, port.stderr);
		assert.strictEqual(port.stdout, '41999\n');
		const absent = await runCli(['dev', 'stop', '--port', '41999', '--query', 'stopped.1'], { cwd: root, core });
		assert.strictEqual(absent.code, 0, absent.stderr);
		assert.strictEqual(absent.stdout, '\n');
		const noJson = await runCli(['dev', '--query', 'port'], { cwd: fixtureApp() });
		assert.strictEqual(noJson.code, 2);
		assert.match(
			noJson.stderr,
			/^Error: --query is not supported for "blocks dev": it has no JSON result\.\nTry: blocks dev --help\n$/,
		);
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

describe('blocks dev stop', () => {
	/** A core whose stopDevServer records the ports it is asked to stop, and finds nothing running. */
	function stopCore() {
		const stops: number[] = [];
		return {
			stops,
			core: {
				stopDevServer: async (port = 3000) => {
					stops.push(port);
					return {
						port,
						stopped: false,
						alreadyStopped: true,
						portFree: true,
						record: null,
						pids: [],
						via: 'none' as const,
					};
				},
			},
		};
	}

	it('rejects --port with --all, and with blocks cleanup, before it stops anything (exit 2)', async () => {
		for (const argv of [
			['dev', 'stop', '--all', '--port', '41020'],
			['cleanup', '--port', '41020'],
		]) {
			const { stops, core } = stopCore();
			const run = await runCli(argv, { cwd: fixtureApp(), core });
			assert.strictEqual(run.code, 2, argv.join(' '));
			assert.match(
				run.stderr,
				/^Error: --all stops every dev server this app recorded: it cannot be combined with --port\./,
			);
			assert.deepStrictEqual(stops, []);
		}
	});

	it('reads only the port, so an invalid unrelated blocks.dev setting does not stop it', async () => {
		const { stops, core } = stopCore();
		const cwd = fixtureApp({ blocks: { dev: { port: 41030, frontend: true, frontendCommand: '' } } });
		const run = await runCli(['dev', 'stop'], { cwd, core });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(stops, [41030]);
		// The port itself must still be valid: it says which server to stop.
		const bad = await runCli(['dev', 'stop'], { cwd: fixtureApp({ blocks: { dev: { port: 'x' } } }), core });
		assert.strictEqual(bad.code, 2);
		assert.match(bad.stderr, /"blocks\.dev\.port" must be a port number/);
	});

	it('warns about an unknown blocks.dev key, and accepts generateClient', async () => {
		const { core } = stopCore();
		const cwd = fixtureApp({ blocks: { dev: { prot: 4000, generateClient: false, zzz: 1 } } });
		for (const argv of [['dev', 'stop'], ['dev']]) {
			const run = await runCli(argv, { cwd, core });
			assert.match(
				run.stderr,
				/^Warning: package\.json "blocks\.dev\.prot" is not a dev setting, and is ignored\. Did you mean "port"\?\n/m,
				argv.join(' '),
			);
			assert.match(
				run.stderr,
				/"blocks\.dev\.zzz" is not a dev setting, and is ignored\. The settings are port, host, frontendCommand, frontendPort, frontend\./,
			);
			assert.doesNotMatch(run.stderr, /generateClient/);
		}
	});

	it('without --port, stops the only dev server recorded on another port, and lists several', async () => {
		const cwd = fixtureApp();
		mkdirSync(join(cwd, '.blocks-sandbox'));
		writeFileSync(join(cwd, '.blocks-sandbox', 'dev-server.4000.pid'), '');
		const one = stopCore();
		const run = await runCli(['dev', 'stop'], { cwd, core: one.core });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.deepStrictEqual(one.stops, [4000]);
		assert.match(run.stderr, /No dev server is recorded on :3000; stopping the one on :4000\./);
		// An explicit --port is what the user asked for.
		const explicit = stopCore();
		await runCli(['dev', 'stop', '--port', '3000'], { cwd, core: explicit.core });
		assert.deepStrictEqual(explicit.stops, [3000]);
		writeFileSync(join(cwd, '.blocks-sandbox', 'dev-server.4001.pid'), '');
		const several = stopCore();
		const listed = await runCli(['dev', 'stop'], { cwd, core: several.core });
		assert.strictEqual(listed.code, 0, listed.stderr);
		assert.deepStrictEqual(several.stops, [3000]);
		assert.match(
			listed.stderr,
			/Warning: No dev server is recorded on :3000, but this app recorded ones on :4000, :4001\. Stop one with blocks dev stop --port <port>, or all of them with blocks dev stop --all\./,
		);
	});
});

describe('blocks secret and config', () => {
	it('exits 130 on Ctrl-C or Ctrl-D at the hidden prompt, with no error', async () => {
		const run = await runCli(['secret', 'set', 'ZZ_CTRL'], {
			cwd: fixtureApp(),
			core: {
				runSecretCli: async () => {
					throw Object.assign(new Error('The prompt was interrupted; nothing was set.'), {
						name: 'ValueCliInterruptedError',
					});
				},
			},
		});
		assert.strictEqual(run.code, 130);
		assert.strictEqual(run.stderr, 'Interrupted; nothing was set.\n');
	});

	it('leaves stdin that is not a terminal to the tool, and refuses prompts only for --no-input or CI', async () => {
		const cwd = fixtureApp();
		const seen: (boolean | undefined)[] = [];
		const core = {
			runSecretCli: async (_args: string[], options?: { interactive?: boolean }) => {
				seen.push(options?.interactive);
			},
		};
		await runCli(['secret', 'set', 'K'], { cwd, core, stdinIsTTY: false });
		await runCli(['--no-input', 'secret', 'set', 'K'], { cwd, core, stdinIsTTY: true });
		await runCli(['secret', 'set', 'K'], { cwd, core, env: { CI: 'true' }, stdinIsTTY: true });
		// The tool then reports a non-TTY stdin as such, not as "--no-input or CI".
		assert.deepStrictEqual(seen, [true, false, false]);
	});

	it('exits 2 with no --verbose hint for a bare command and an invalid key', async () => {
		const cwd = fixtureApp();
		for (const name of ['secret', 'config']) {
			const bare = await runCli([name], { cwd });
			assert.strictEqual(bare.code, 2);
			assert.strictEqual(
				bare.stderr,
				`Error: "blocks ${name}" needs a verb: set, list or remove.\nTry: blocks ${name} --help\n`,
			);
		}
		// The real tool: the key is checked before any store call.
		const bad = await runCli(['secret', 'remove', 'bad-key'], { cwd, core: { runSecretCli } });
		assert.strictEqual(bad.code, 2, bad.stderr);
		assert.match(bad.stderr, /^Error: Invalid key "bad-key"\./);
		assert.doesNotMatch(bad.stderr, /--verbose/);
	});
});
