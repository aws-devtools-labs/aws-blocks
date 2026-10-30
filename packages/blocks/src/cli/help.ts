// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Grouped root help and per-command help, rendered from the registry. Aliases never appear. */

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
	const parts = ['blocks', ...command.path];
	if (!command.handler) parts.push('<command>');
	parts.push(...args);
	if (command.flags?.length) parts.push('[options]');
	return parts.join(' ');
}

/** The root help: every canonical command, grouped. */
export function rootHelp(version: string): string {
	const lines = [
		`AWS Blocks CLI ${version}`,
		'',
		'Usage: blocks [global options] <command> [<subcommand>] [arguments] [-- passthrough]',
	];
	for (const group of GROUPS) {
		const commands = COMMANDS.filter((command) => command.group === group && command.handler);
		if (commands.length === 0) continue;
		lines.push('', group, ...table(commands.map((command) => [command.path.join(' '), command.summary])));
	}
	lines.push(
		'',
		'Global options',
		...table(GLOBAL_FLAGS.map((flag) => [flagLabel(flag), flag.description])),
		'',
		'Exit codes: 0 success, 1 failed, 2 usage error, 130 interrupted.',
		'Run "blocks help <command>" or "blocks <command> --help" for details.',
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
		lines.push('', 'Commands', ...table(subcommands.map((sub) => [sub.path.join(' '), sub.summary])));
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
		lines.push('', `Global options go before "${command.path[0]}"; every token after it is forwarded unchanged.`);
	} else {
		lines.push('', 'Global options: see "blocks --help".');
	}
	return `${lines.join('\n')}\n`;
}
