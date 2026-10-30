// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Argument parsing for the `blocks` CLI, on `node:util` `parseArgs`.
 *
 * `blocks [global options] <command> [<subcommand>] [arguments] [-- passthrough]`
 *
 * Global options may come before or after the command. A passthrough command
 * (`db`, `secret`, `config`, `vendorize`) forwards every token after its name
 * verbatim, so its global options must come before it.
 */

import { parseArgs } from 'node:util';
import { UsageError, unknownField } from './errors.js';
import {
	ALIASES,
	type AliasSpec,
	COMMANDS,
	type CommandSpec,
	type FlagSpec,
	type FlagValues,
	findCommand,
	GLOBAL_FLAGS,
	subcommandsOf,
} from './registry.js';

export interface Globals {
	help: boolean;
	version: boolean;
	quiet: boolean;
	verbose: boolean;
	debug: boolean;
	output: 'text' | 'json';
	yes: boolean;
	noInput: boolean;
	profile?: string;
	region?: string;
	cwd?: string;
	/** A dotted path into the JSON result; its value prints raw. */
	query?: string;
}

export interface ParsedInvocation {
	/** Undefined for the root (`blocks`, `blocks --help`, `blocks --version`). */
	command?: CommandSpec;
	/** The alias the user typed, when it was one. */
	alias?: string;
	globals: Globals;
	flags: FlagValues;
	positionals: string[];
	passthrough: string[];
	/**
	 * For help on a passthrough command: the verb whose own help to show
	 * (`migrate` in `blocks db migrate ./dir --help`). Only `<verb> --help` is
	 * forwarded to the tool, never the other arguments.
	 */
	helpVerb?: string;
}

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions (`deplyo` → `deploy` is 1). */
export function editDistance(a: string, b: string): number {
	const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[a.length][b.length];
}

/** The closest candidate within a typo's reach, if any. */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const distance = editDistance(input, candidate);
		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined;
}

const didYouMean = (suggestion: string | undefined) => (suggestion ? ` Did you mean "${suggestion}"?` : '');

/** A command, and the alias that names it, in the name index. */
interface IndexEntry {
	command: CommandSpec;
	alias?: AliasSpec;
}

/** Every command and alias name, keyed by its space-joined tokens. */
function nameIndex(): Map<string, IndexEntry> {
	const index = new Map<string, IndexEntry>();
	for (const command of COMMANDS) index.set(command.path.join(' '), { command });
	for (const alias of ALIASES) {
		const command = findCommand(alias.target);
		if (!command) throw new Error(`alias ${alias.name.join(' ')} targets an unknown command`);
		index.set(alias.name.join(' '), { command, alias });
	}
	return index;
}

const isOption = (token: string) => token.startsWith('-') && token !== '-';

/** The global flag a leading token names, with the number of tokens it consumes. */
function leadingGlobal(argv: readonly string[], i: number): { flag: FlagSpec; value?: string; used: number } {
	const token = argv[i];
	const [raw, inline] = token.startsWith('--') ? splitInline(token) : [token, undefined];
	const flag = GLOBAL_FLAGS.find((f) =>
		raw.startsWith('--') ? `--${f.name}` === raw : f.short && `-${f.short}` === raw,
	);
	if (!flag) {
		throw new UsageError(
			`unknown option "${raw}".${didYouMean(
				suggest(
					raw,
					GLOBAL_FLAGS.map((f) => `--${f.name}`),
				),
			)}`,
			{ hint: 'blocks --help' },
		);
	}
	if (flag.type === 'boolean') {
		if (inline !== undefined) throw new UsageError(`option --${flag.name} does not take a value.`);
		return { flag, used: 1 };
	}
	if (inline !== undefined) return { flag, value: inline, used: 1 };
	const next = argv[i + 1];
	if (next === undefined || isOption(next)) throw new UsageError(`option --${flag.name} needs a value.`);
	return { flag, value: next, used: 2 };
}

function splitInline(token: string): [string, string | undefined] {
	const eq = token.indexOf('=');
	return eq === -1 ? [token, undefined] : [token.slice(0, eq), token.slice(eq + 1)];
}

function toGlobals(values: FlagValues): Globals {
	const output = values.output ?? 'text';
	if (output !== 'text' && output !== 'json') {
		throw new UsageError(`option --output must be "text" or "json", not ${JSON.stringify(output)}.`);
	}
	const text = (name: string) => (typeof values[name] === 'string' ? (values[name] as string) : undefined);
	return {
		help: values.help === true,
		version: values.version === true,
		quiet: values.quiet === true,
		verbose: values.verbose === true,
		debug: values.debug === true,
		output,
		yes: values.yes === true,
		noInput: values['no-input'] === true,
		profile: text('profile'),
		region: text('region'),
		cwd: text('cwd'),
		query: text('query'),
	};
}

/**
 * Parse the flags and positionals after a command with `parseArgs`, then
 * validate them against the command's declared flags.
 */
function parseCommandArgs(
	command: CommandSpec,
	tokens: readonly string[],
	values: FlagValues,
): { positionals: string[]; passthrough: string[] } {
	const specs = [...GLOBAL_FLAGS, ...(command.flags ?? [])];
	const options: Record<string, { type: 'boolean' | 'string'; short?: string; multiple?: boolean }> = {};
	for (const spec of specs) {
		options[spec.name] = {
			type: spec.type === 'string' ? 'string' : 'boolean',
			...(spec.short ? { short: spec.short } : {}),
		};
	}
	const parsed = parseArgs({ args: [...tokens], options, strict: false, allowPositionals: true, tokens: true });
	const positionals: string[] = [];
	const passthrough: string[] = [];
	let terminated = false;
	const name = `blocks ${command.path.join(' ')}`;
	for (const token of parsed.tokens ?? []) {
		if (token.kind === 'option-terminator') {
			terminated = true;
			continue;
		}
		if (token.kind === 'positional') {
			(terminated ? passthrough : positionals).push(token.value);
			continue;
		}
		const spec = specs.find((s) => s.name === token.name);
		if (!spec) {
			const candidates = specs.map((s) => `--${s.name}`);
			throw new UsageError(
				`unknown option "${token.rawName}" for "${name}".${didYouMean(suggest(token.rawName, candidates))}`,
				{ hint: `${name} --help` },
			);
		}
		let value: string | boolean;
		if (spec.type === 'boolean') {
			if (token.inlineValue) throw new UsageError(`option --${spec.name} does not take a value.`);
			value = true;
		} else if (spec.type === 'optional-string') {
			value = token.inlineValue && token.value !== undefined ? token.value : true;
		} else {
			if (token.value === undefined || (!token.inlineValue && isOption(token.value))) {
				throw new UsageError(`option --${spec.name} needs a value.`, { hint: `${name} --help` });
			}
			value = token.value;
		}
		if (spec.multiple) {
			const list = Array.isArray(values[spec.name]) ? (values[spec.name] as string[]) : [];
			values[spec.name] = [...list, String(value)];
		} else {
			values[spec.name] = value;
		}
	}
	return { positionals, passthrough };
}

function checkPositionals(command: CommandSpec, positionals: string[]): void {
	const name = `blocks ${command.path.join(' ')}`;
	const args = command.args ?? [];
	const variadic = args.some((a) => a.variadic);
	if (positionals.length > args.length && !variadic) {
		const extra = positionals[args.length];
		const subcommands = subcommandsOf(command.path);
		if (subcommands.length > 0 && args.length === 0) {
			const candidates = subcommands.map((s) => s.path.join(' '));
			throw new UsageError(
				`unknown command "${[...command.path, extra].join(' ')}".${didYouMean(suggest([...command.path, extra].join(' '), candidates))}`,
				{ hint: `${name} --help` },
			);
		}
		throw new UsageError(`unexpected argument "${extra}" for "${name}".`, { hint: `${name} --help` });
	}
	const missing = args.find((a, i) => a.required && positionals[i] === undefined);
	if (missing) throw new UsageError(`"${name}" needs the <${missing.name}> argument.`, { hint: `${name} --help` });
}

/**
 * Parse a full argv (without the node and script entries).
 *
 * @throws {UsageError} On an unknown command or option, a missing value or
 * argument, or an unexpected argument. The message suggests the closest name.
 */
export function parseArgv(argv: readonly string[]): ParsedInvocation {
	const values: FlagValues = {};
	let i = 0;
	while (i < argv.length && isOption(argv[i]) && argv[i] !== '--') {
		const { flag, value, used } = leadingGlobal(argv, i);
		values[flag.name] = value ?? true;
		i += used;
	}
	if (argv[i] === '--') i++;

	const rest = argv.slice(i);
	if (rest.length === 0) return { globals: toGlobals(values), flags: values, positionals: [], passthrough: [] };

	const index = nameIndex();
	let match: IndexEntry | undefined;
	let used = 0;
	for (let n = Math.min(3, rest.length); n > 0 && !match; n--) {
		if (rest.slice(0, n).some(isOption)) continue;
		match = index.get(rest.slice(0, n).join(' '));
		if (match) used = n;
	}
	if (!match) {
		const topLevel = [...index.keys()].filter((key) => !key.includes(' '));
		throw new UsageError(`unknown command "${rest[0]}".${didYouMean(suggest(rest[0], topLevel))}`, {
			hint: 'blocks --help',
		});
	}

	const { command, alias } = match;
	const tail = [...(alias?.args ?? []), ...rest.slice(used)];
	const aliasName = alias?.name.join(' ');

	let parsed: ParsedInvocation;
	if (command.passthrough) {
		// `-h`/`--help` anywhere after a passthrough command means help, never a run
		// with the user's arguments: `blocks config remove KEY --help` must not delete KEY.
		const help = tail.some((token) => token === '-h' || token === '--help');
		if (help) values.help = true;
		parsed = {
			command,
			alias: aliasName,
			globals: toGlobals(values),
			flags: values,
			positionals: [],
			passthrough: help ? [] : tail,
			helpVerb: help ? tail.find((token) => command.verbs?.includes(token)) : undefined,
		};
	} else {
		const { positionals, passthrough } = parseCommandArgs(command, tail, values);
		parsed = { command, alias: aliasName, globals: toGlobals(values), flags: values, positionals, passthrough };
		if (!parsed.globals.help) {
			checkPositionals(command, positionals);
			// Only passthrough commands forward arguments after `--`; elsewhere they would be dropped.
			if (passthrough.length > 0) {
				throw new UsageError(`unexpected arguments after --: ${passthrough.join(' ')}`, {
					hint: `blocks ${command.path.join(' ')} --help`,
				});
			}
		}
	}
	const { globals } = parsed;
	if (!globals.help && command.handler && (globals.output === 'json' || globals.query !== undefined)) {
		const name = `blocks ${command.path.join(' ')}`;
		if (!command.json) {
			throw new UsageError(`"${name}" has no JSON output${globals.query === undefined ? '' : ' to query'}.`, {
				hint: name,
			});
		}
		// Check the top-level field before the command runs, so a typo never repeats a deploy.
		const field = globals.query?.split('.')[0];
		if (field !== undefined && !command.json.includes(field))
			throw unknownField(globals.query ?? field, name, command.json);
	}
	return parsed;
}
