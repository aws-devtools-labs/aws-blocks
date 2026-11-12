// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every task script a create-blocks-app template ships must name a command this
 * CLI runs. Without this, a template can offer `npm run <x>` for a command that
 * was never registered, and the app it scaffolds fails on first use.
 *
 * Templates invoke the runner as
 * `node --input-type=module -e "import '@aws-blocks/blocks/run'" -- <command>`,
 * so the command tokens are the words after the runner's `--`. The detection
 * keys on the `@aws-blocks/blocks/run` import rather than on the invocation's
 * exact spelling, and {@link runnerScripts} asserts it still matches something:
 * a guard that silently selects no scripts asserts nothing, which is the state
 * this file exists to prevent.
 */

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALIASES, findCommand, GLOBAL_FLAGS } from './registry.js';

const TEMPLATES_DIR = fileURLToPath(new URL('../../../create-blocks-app/templates/', import.meta.url));

/** The entry point every template's task scripts import to run a command. */
const RUNNER_ENTRY = '@aws-blocks/blocks/run';

/** Whether this script runs a CLI command, as opposed to vite, tsc or the app's own test. */
function runsRunner(script: string): boolean {
	return script.includes(RUNNER_ENTRY);
}

/** The arguments a task script passes to the runner: the words after its `--`. */
function runnerArgs(script: string): string[] {
	const words = script.split(/\s+/);
	const separator = words.indexOf('--');
	return separator === -1 ? [] : words.slice(separator + 1);
}

/** The command tokens of a task script: its runner arguments up to the first flag. */
function commandTokens(script: string): string[] {
	const tokens: string[] = [];
	for (const word of runnerArgs(script)) {
		if (word.startsWith('-')) break;
		tokens.push(word);
	}
	return tokens;
}

/**
 * A script that names no command but passes global options only, as the
 * template's `help` task does with `--help`. Those run the runner itself rather
 * than a command, so they have nothing for {@link isRunnable} to look up; the
 * options are still checked, so a typo is not waved through as "global".
 */
function isGlobalOptionsOnly(script: string): boolean {
	const args = runnerArgs(script);
	if (args.length === 0) return false;
	return args.every((arg) => {
		const name = /^--?([^=]+)/.exec(arg)?.[1];
		return name !== undefined && GLOBAL_FLAGS.some((flag) => flag.name === name || flag.short === name);
	});
}

/**
 * Whether the CLI runs these tokens. The longest prefix wins, so the arguments
 * of a command that takes them (`generate client <foundation>`) do not hide the
 * command. A shorter prefix only counts when the command it names can take the
 * tokens left over: otherwise a misspelled subcommand (`sandbox deplyo`) would
 * pass here and still exit with `unknown command`, which is the drift this
 * guard exists to catch.
 */
function isRunnable(tokens: string[]): boolean {
	for (let length = tokens.length; length > 0; length--) {
		const path = tokens.slice(0, length);
		const extra = tokens.length - length;
		const command = findCommand(path);
		if (command?.handler && (extra === 0 || command.args?.length || command.passthrough)) return true;
		if (extra === 0 && ALIASES.some((alias) => alias.name.join(' ') === path.join(' '))) return true;
	}
	return false;
}

function templateScripts(template: string): Record<string, string> {
	const pkg = JSON.parse(readFileSync(join(TEMPLATES_DIR, template, 'package.json'), 'utf-8')) as {
		scripts?: Record<string, string>;
	};
	return pkg.scripts ?? {};
}

/** Every template's runner scripts as `[template, name, script]`, which must not be empty. */
function runnerScripts(): [string, string, string][] {
	const templates = readdirSync(TEMPLATES_DIR).filter((name) => existsSync(join(TEMPLATES_DIR, name, 'package.json')));
	assert.ok(templates.length > 0, `templates found under ${TEMPLATES_DIR}`);
	const scripts: [string, string, string][] = [];
	for (const template of templates) {
		for (const [name, script] of Object.entries(templateScripts(template))) {
			if (runsRunner(script)) scripts.push([template, name, script]);
		}
	}
	// A detection that matches nothing would make every assertion below vacuous.
	assert.ok(scripts.length > 0, `template scripts running ${RUNNER_ENTRY} found`);
	return scripts;
}

describe('template scripts and the CLI', () => {
	it('runs every task script that a template ships', () => {
		const unrunnable = runnerScripts()
			.filter(([, , script]) => !isRunnable(commandTokens(script)) && !isGlobalOptionsOnly(script))
			.map(([template, name, script]) => `${template}: "${name}": "${script}"`);
		assert.deepStrictEqual(unrunnable, []);
	});

	it('finds a command in the task scripts that name one, so the check is not vacuous', () => {
		const naming = runnerScripts().filter(([, , script]) => commandTokens(script).length > 0);
		// Every template ships dev, sandbox, deploy and more; a handful would mean the
		// `--` parsing stopped matching the invocation the templates actually use.
		assert.ok(naming.length > 20, `task scripts naming a command: ${naming.length}`);
	});

	it('offers the dashboard and its doctor from the default template', () => {
		const scripts = templateScripts('default');
		for (const [name, tokens] of [
			['dashboard', ['dashboard']],
			['dashboard:doctor', ['dashboard', 'doctor']],
		] as const) {
			const script = scripts[name];
			assert.ok(script !== undefined && runsRunner(script), `default template "${name}" script: ${script}`);
			assert.deepStrictEqual(commandTokens(script), [...tokens], name);
			assert.ok(isRunnable(commandTokens(script)), name);
		}
	});

	it('does not accept a misspelled subcommand of a command that takes no arguments', () => {
		assert.ok(!isRunnable(['sandbox', 'deplyo']));
		assert.ok(!isRunnable(['dashboard', 'doctr']));
		assert.ok(!isRunnable(['generate', 'types', 'out.d.ts']), 'generate types takes --out, not a positional');
		assert.ok(isRunnable(['sandbox', 'deploy']));
		assert.ok(isRunnable(['generate', 'client', 'aws-blocks/index.ts']));
	});
});
