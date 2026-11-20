// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Grouped root help and per-command help, rendered from the registry. Uses package-manager task names. */

import { blocksCommand } from './errors.js';
import { COMMANDS, type CommandSpec, type FlagSpec, GLOBAL_FLAGS, GROUPS, subcommandsOf } from './registry.js';

function table(rows: [string, string][], indent = '  '): string[] {
	const width = Math.max(...rows.map(([left]) => left.length)) + 2;
	return rows.map(([left, right]) => `${indent}${left.padEnd(width)}${right}`);
}

function flagLabel(flag: FlagSpec): string {
	const long = `--${flag.name}`;
	const value =
		flag.type === 'string'
			? ` <${flag.value ?? 'value'}>`
			: flag.type === 'optional-string'
				? `[=${flag.value ?? 'value'}]`
				: '';
	return `${flag.short ? `-${flag.short}, ` : '    '}${long}${value}`;
}

function usageLine(command: CommandSpec): string {
	const args = (command.args ?? []).map((arg) => {
		const name = arg.variadic ? `${arg.name}...` : arg.name;
		return arg.required ? `<${name}>` : `[${name}]`;
	});
	const parts = [blocksCommand(command.path[0], ...command.path.slice(1))];
	if (!command.handler) return parts[0];
	parts.push(...args);
	if (command.path[0] !== 'help') parts.push('[-- <options>]');
	return parts.join(' ');
}

/** The root help: every canonical command, grouped. */
export function rootHelp(version: string): string {
	const lines = [
		`AWS CDK Blocks tasks ${version}`,
		'',
		'Usage: npm run <task> [arguments] [-- <options>]',
	];
	for (const group of GROUPS) {
		const commands = COMMANDS.filter((command) => command.group === group && command.handler);
		if (commands.length === 0) continue;
		lines.push('', group, ...table(commands.map((command) => [blocksCommand(command.path[0], ...command.path.slice(1)).slice('npm run '.length), command.summary])));
		if (group === 'Develop') {
			lines.push(...table([
				['docs:api', 'Read exact API signatures'],
				['docs:search', 'Search the CDK Blocks docs'],
			]));
		}
	}
	lines.push(
		'',
		'Global options',
		...table(GLOBAL_FLAGS.map((flag) => [flagLabel(flag), flag.description])),
		'JSON results go to stdout; progress goes to stderr. Use npm run -s to suppress npm’s script banners.',
		'',
		'Exit codes: 0 success, 1 failed, 2 usage error, 130 interrupted, 143 stopped by SIGTERM.',
		'Run "npm run help" for this list, or "npm run <task> -- --help" for details.',
	);
	return `${lines.join('\n')}\n`;
}

/** Help for one command: description, usage, arguments, options, subcommands and examples. */
export function commandHelp(command: CommandSpec): string {
	const lines = [command.description ?? command.summary, '', `Usage: ${usageLine(command)}`];
	if (command.args?.length) {
		lines.push('', 'Arguments', ...table(command.args.map((arg) => [arg.name, arg.description])));
	}
	if (command.flags?.length) {
		lines.push('', 'Options', ...table(command.flags.map((flag) => [flagLabel(flag), flag.description])));
	}
	const subcommands = subcommandsOf(command.path);
	if (subcommands.length > 0) {
		lines.push('', 'Commands', ...table(subcommands.map((sub) => [blocksCommand(sub.path[0], ...sub.path.slice(1)).slice('npm run '.length), sub.summary])));
	}
	if (command.examples?.length) {
		lines.push(
			'',
			'Examples',
			...table(
				command.examples.map((example) => [example.command, `# ${example.description}`]),
				'  ',
			).map((line) => line.trimEnd()),
		);
	}
	if (command.passthrough) {
		lines.push(
			'',
		'After npm’s separator, global options apply before a second "--"; the remaining tokens are forwarded unchanged.',
		);
	} else {
		lines.push('', 'Global options: see "npm run help".');
	}
	return `${lines.join('\n')}\n`;
}
