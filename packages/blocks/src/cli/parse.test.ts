// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ExitCode, UsageError } from './errors.js';
import { editDistance, parseArgv, suggest } from './parse.js';
import { ALIASES, findCommand } from './registry.js';
import { fixtureApp, runCli } from './test-helpers.js';

function usageError(argv: string[], pattern: RegExp): void {
	assert.throws(
		() => parseArgv(argv),
		(error: unknown) => {
			assert.ok(error instanceof UsageError);
			assert.strictEqual(error.exitCode, ExitCode.Usage);
			assert.match(error.message, pattern);
			return true;
		},
	);
}

describe('parseArgv', () => {
	it('parses global options before and after the command', () => {
		const parsed = parseArgv([
			'--profile',
			'dev',
			'-C',
			'app',
			'deploy',
			'--region=eu-west-1',
			'-q',
			'--output',
			'json',
		]);
		assert.deepStrictEqual(parsed.command?.path, ['deploy']);
		assert.strictEqual(parsed.globals.profile, 'dev');
		assert.strictEqual(parsed.globals.region, 'eu-west-1');
		assert.strictEqual(parsed.globals.cwd, 'app');
		assert.strictEqual(parsed.globals.quiet, true);
		assert.strictEqual(parsed.globals.output, 'json');
	});

	it('keeps -v as --verbose and --version long-only', () => {
		assert.strictEqual(parseArgv(['-v', 'dev']).globals.verbose, true);
		assert.strictEqual(parseArgv(['-v', 'dev']).globals.version, false);
		assert.strictEqual(parseArgv(['--version']).globals.version, true);
	});

	it('reads command flags, including an optional inline value', () => {
		assert.strictEqual(parseArgv(['deploy', '--wait-live']).flags['wait-live'], true);
		assert.strictEqual(parseArgv(['deploy', '--wait-live=30']).flags['wait-live'], '30');
		const dev = parseArgv(['dev', '--port', '4000', '--frontend-command', 'npx vite --port 3100']);
		assert.strictEqual(dev.flags.port, '4000');
		assert.strictEqual(dev.flags['frontend-command'], 'npx vite --port 3100');
		assert.deepStrictEqual(
			parseArgv(['generate', 'types', '--include', 'a/**', '--include', 'b/**']).flags.include,
			['a/**', 'b/**'],
		);
	});

	it('rejects arguments after -- for a command that does not forward them', () => {
		usageError(
			['generate', 'client', 'in.ts', '--', '--not-a-flag'],
			/^unexpected arguments after --: --not-a-flag$/,
		);
		usageError(['deploy', '--', '--wait-live'], /^unexpected arguments after --: --wait-live$/);
		assert.deepStrictEqual(parseArgv(['generate', 'client', 'in.ts', '--']).positionals, ['in.ts']);
		assert.deepStrictEqual(parseArgv(['--', 'whoami']).command?.path, ['whoami']);
		// Passthrough commands still forward everything, `--` included.
		assert.deepStrictEqual(parseArgv(['db', 'migrate', '--', '--x']).passthrough, ['migrate', '--', '--x']);
	});

	it('rejects an unknown command with a suggestion', () => {
		usageError(['deplyo'], /^unknown command "deplyo"\. Did you mean "deploy"\?$/);
		usageError(['sandbox', 'destory'], /unknown command "sandbox destory"\. Did you mean "sandbox destroy"\?/);
		usageError(['generate', 'clinet'], /Did you mean "generate client"\?/);
		usageError(['zzzzzzzz'], /^unknown command "zzzzzzzz"\.$/);
	});

	it('rejects an unknown flag with a suggestion', () => {
		usageError(['destroy', '--yse'], /unknown option "--yse" for "blocks destroy"\. Did you mean "--yes"\?/);
		usageError(['--prfile', 'x', 'deploy'], /unknown option "--prfile"\. Did you mean "--profile"\?/);
		usageError(['dev', '-z'], /unknown option "-z"/);
	});

	it('rejects missing values, values on boolean flags and bad --output', () => {
		usageError(['dev', '--port'], /option --port needs a value/);
		usageError(['dev', '--port', '--host', 'x'], /option --port needs a value/);
		usageError(['destroy', '--yes=1'], /option --yes does not take a value/);
		usageError(['--output', 'yaml', 'whoami'], /--output must be "text" or "json"/);
		usageError(['dev', '--output', 'json'], /"blocks dev" has no JSON output/);
	});

	it('rejects missing and unexpected arguments', () => {
		usageError(['whoami', 'extra'], /unexpected argument "extra"/);
		usageError(['generate', 'client', 'a', 'b', 'c'], /unexpected argument "c"/);
	});

	it('resolves every alias to its canonical command', () => {
		for (const alias of ALIASES) {
			const parsed = parseArgv([...alias.name]);
			assert.deepStrictEqual(parsed.command?.path, alias.target, alias.name.join(' '));
			assert.strictEqual(parsed.alias, alias.name.join(' '));
		}
		assert.strictEqual(parseArgv(['cleanup']).flags.all, true);
		assert.strictEqual(parseArgv(['typegen', '--check']).flags.check, true);
		assert.deepStrictEqual(parseArgv(['console']).command, findCommand(['sandbox', 'console']));
	});

	it('resolves "sandbox --deploy-only" to "sandbox deploy", JSON output included', () => {
		const parsed = parseArgv(['sandbox', '--deploy-only', '--output', 'json']);
		assert.deepStrictEqual(parsed.command?.path, ['sandbox', 'deploy']);
		assert.strictEqual(parsed.alias, 'sandbox --deploy-only');
		assert.strictEqual(parsed.globals.output, 'json');
		assert.deepStrictEqual(parseArgv(['-q', 'sandbox', '--deploy-only']).command?.path, ['sandbox', 'deploy']);
		usageError(['sandbox', 'destroy', '--deploy-only'], /unknown option "--deploy-only"/);
	});

	it('reads --telemetry-file as a global option, before or after the command', () => {
		assert.strictEqual(parseArgv(['dev', '--telemetry-file=a.json']).globals.telemetryFile, 'a.json');
		assert.strictEqual(parseArgv(['dev', '--telemetry-file', 'a.json']).globals.telemetryFile, 'a.json');
		assert.strictEqual(parseArgv(['--telemetry-file', 'a.json', 'deploy']).globals.telemetryFile, 'a.json');
		usageError(['dev', '--telemetry-file'], /--telemetry-file needs a value/);
	});

	it('forwards everything after a passthrough command verbatim', () => {
		const argv = ['set', 'KEY', '--stage', 'prod', '--value-stdin', '--', '-x'];
		assert.deepStrictEqual(parseArgv(['secret', ...argv]).passthrough, argv);
		const help = parseArgv(['db', '--help']);
		assert.strictEqual(help.globals.help, true);
		assert.deepStrictEqual(help.passthrough, []);
		assert.strictEqual(help.helpVerb, undefined);
	});

	it('turns --help anywhere after a passthrough command into help, keeping only the verb', () => {
		for (const [argv, verb] of [
			[['db', 'status', '--help'], 'status'],
			[['db', 'pull', './out', '-h'], 'pull'],
			[['config', 'remove', 'KEY', '--help'], 'remove'],
			[['secret', '--stage', 'prod', 'remove', 'KEY', '--force', '--yes', '--help'], 'remove'],
			[['vendorize', '@aws-blocks/bb-kv-store', '--help'], undefined],
			[['db', 'drop', 'x', '--help'], undefined],
		] as const) {
			const parsed = parseArgv(argv);
			assert.strictEqual(parsed.globals.help, true, argv.join(' '));
			assert.deepStrictEqual(parsed.passthrough, [], argv.join(' '));
			assert.strictEqual(parsed.helpVerb, verb, argv.join(' '));
		}
	});
});

describe('suggest', () => {
	it('counts a transposition as one edit', () => {
		assert.strictEqual(editDistance('deplyo', 'deploy'), 1);
		assert.strictEqual(suggest('whoamy', ['whoami', 'deploy']), 'whoami');
		assert.strictEqual(suggest('qqqqqq', ['whoami', 'deploy']), undefined);
	});
});

describe('usage errors through main', () => {
	it('exits 2 with the error and the Try line on stderr', async () => {
		const run = await runCli(['deplyo'], { cwd: fixtureApp() });
		assert.strictEqual(run.code, 2);
		assert.strictEqual(run.stdout, '');
		assert.match(run.stderr, /^Error: unknown command "deplyo"\. Did you mean "deploy"\?\nTry: blocks --help\n$/);
	});

	it('exits 2 for a command group without a subcommand', async () => {
		const run = await runCli(['generate'], { cwd: fixtureApp() });
		assert.strictEqual(run.code, 2);
		assert.match(run.stderr, /generate client/);
	});
});
