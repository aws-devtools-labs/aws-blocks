// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Argument parsing for the `cdk-blocks` CLI, on `node:util` `parseArgs`.
 *
 * `cdk-blocks [global options] <command> [<subcommand>] [arguments] [-- passthrough]`
 *
 * Global options may come before the command, between the words of its path
 * (`cdk-blocks generate --debug client`) or after it. A passthrough command (`db`,
 * `secret`, `config`, `vendorize`) forwards the tokens after its name to its
 * tool, except the CLI's global options before a `--`: those apply to the run.
 */

import { parseArgs } from 'node:util';
import { BLOCKS_COMMAND, blocksCommand, UsageError } from './errors.js';
import {
	ALIASES,
	type AliasSpec,
	COMMANDS,
	type CommandSpec,
	FLAG_ALIASES,
	type FlagSpec,
	type FlagValues,
	findCommand,
	GLOBAL_FLAGS,
	type JsonObjectShape,
	type JsonShape,
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
	/** Where core also writes the telemetry events; forwarded to the runners. */
	telemetryFile?: string;
}

export interface ParsedInvocation {
	/** Undefined for the root (`cdk-blocks`, `cdk-blocks --help`, `cdk-blocks --version`). */
	command?: CommandSpec;
	/** The alias the user typed, when it was one. */
	alias?: string;
	globals: Globals;
	flags: FlagValues;
	positionals: string[];
	passthrough: string[];
	/**
	 * For help on a passthrough command: the verb whose own help to show
	 * (`migrate` in `cdk-blocks db migrate ./dir --help`). Only `<verb> --help` is
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

/**
 * The command closest to `input` among `names` (canonical paths and alias
 * names), as its canonical spelling: aliases are hidden, so a typo of
 * `console` suggests `sandbox console`.
 */
export function suggestCommand(input: string, names: readonly string[]): string | undefined {
	const hit = suggest(input, names);
	const alias = ALIASES.find((a) => a.name.join(' ') === hit);
	return alias ? [...alias.target, ...(alias.args ?? [])].join(' ') : hit;
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

type OptionToken = Extract<NonNullable<ReturnType<typeof parseArgs>['tokens']>[number], { kind: 'option' }>;
type ArgToken = NonNullable<ReturnType<typeof parseArgs>['tokens']>[number];

/** `parseArgs` tokens for `args`, with `specs` as the known options. */
function tokenize(args: readonly string[], specs: readonly FlagSpec[]): ArgToken[] {
	const options: Record<string, { type: 'boolean' | 'string'; short?: string }> = {};
	for (const spec of specs) {
		options[spec.name] = {
			type: spec.type === 'string' ? 'string' : 'boolean',
			...(spec.short ? { short: spec.short } : {}),
		};
	}
	return parseArgs({ args: [...args], options, strict: false, allowPositionals: true, tokens: true }).tokens ?? [];
}

/** Where an option was given: names the command in errors, and the options it accepts. */
interface OptionScope {
	specs: readonly FlagSpec[];
	/** `cdk-blocks deploy`; undefined before the command. */
	command?: string;
}

/** A `blocks …` command line as it runs in an app's shell (see {@link BLOCKS_COMMAND}). */
function runnable(command: string): string {
	return command.replace(/^cdk-blocks\b/, BLOCKS_COMMAND);
}

/**
 * Validate one option token against its scope and record its value.
 * `arg` is the argv entry the token came from.
 *
 * @throws {UsageError} On an unknown option, a value on a boolean option, a
 * missing value, or a single-valued option given twice with different values.
 */
function applyOption(token: OptionToken, arg: string, scope: OptionScope, values: FlagValues): void {
	const spec = scope.specs.find((s) => s.name === token.name);
	const hint = runnable(`${scope.command ?? 'cdk-blocks'} --help`);
	if (!spec) {
		const candidates = scope.specs.map((s) => `--${s.name}`);
		const where = scope.command ? ` for "${scope.command}"` : '';
		throw new UsageError(
			`unknown option "${token.rawName}"${where}.${didYouMean(suggest(token.rawName, candidates))}`,
			{ hint },
		);
	}
	// `-y=false` and `-C=dir`: parseArgs reads the `=` as more short options, or as part of the value.
	if (/^-[^-]=/.test(arg) && token.rawName === arg.slice(0, 2)) {
		if (spec.type === 'boolean') throw new UsageError(`option ${token.rawName} does not take a value.`, { hint });
		throw new UsageError(
			`option ${token.rawName} takes its value after a space: ${token.rawName} <${spec.value ?? 'value'}>, or --${spec.name}=<${spec.value ?? 'value'}>.`,
			{ hint },
		);
	}
	let value: string | boolean;
	if (spec.type === 'boolean') {
		if (token.inlineValue) throw new UsageError(`option ${token.rawName} does not take a value.`, { hint });
		value = true;
	} else if (spec.type === 'optional-string') {
		value = token.inlineValue && token.value !== undefined ? token.value : true;
	} else {
		// A negative number is a value, not an option: `--port -1`.
		if (token.value === undefined || (!token.inlineValue && isOption(token.value) && !/^-\d/.test(token.value))) {
			throw new UsageError(`option --${spec.name} needs a value.`, { hint });
		}
		value = token.value;
	}
	if (spec.multiple) {
		const list = Array.isArray(values[spec.name]) ? (values[spec.name] as string[]) : [];
		values[spec.name] = [...list, String(value)];
		return;
	}
	const previous = values[spec.name];
	if (typeof previous === 'string' && previous !== value) {
		throw new UsageError(
			`option --${spec.name} is given twice, as ${JSON.stringify(previous)} and ${JSON.stringify(value)}; give it once.`,
			{ hint },
		);
	}
	values[spec.name] = value;
}

/**
 * Apply the CLI's global options in a passthrough command's tail, before `--`,
 * and return the tail without them. An argv entry is taken only when every
 * option in it is global (`-qv`, `--profile dev`, `-Capp`); anything else
 * (`--stage prod`, `-x`) is the tool's, and stays.
 */
function liftGlobals(tail: readonly string[], values: FlagValues): string[] {
	const end = tail.includes('--') ? tail.indexOf('--') : tail.length;
	const byEntry = new Map<number, OptionToken[]>();
	for (const token of tokenize(tail.slice(0, end), GLOBAL_FLAGS)) {
		if (token.kind !== 'option') continue;
		byEntry.set(token.index, [...(byEntry.get(token.index) ?? []), token]);
	}
	const lifted = new Set<number>();
	for (const [index, tokens] of byEntry) {
		if (!tokens.every((token) => GLOBAL_FLAGS.some((flag) => flag.name === token.name))) continue;
		for (const token of tokens) applyOption(token, tail[index], { specs: GLOBAL_FLAGS }, values);
		const lastToken = tokens[tokens.length - 1];
		const used = lastToken.value !== undefined && !lastToken.inlineValue ? 2 : 1;
		for (let i = index; i < index + used; i++) lifted.add(i);
	}
	return tail.filter((_, i) => !lifted.has(i));
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
		telemetryFile: text('telemetry-file'),
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
	const scope: OptionScope = {
		specs: [...GLOBAL_FLAGS, ...(command.flags ?? [])],
		command: `cdk-blocks ${command.path.join(' ')}`,
	};
	const positionals: string[] = [];
	const passthrough: string[] = [];
	let terminated = false;
	for (const token of tokenize(tokens, scope.specs)) {
		if (token.kind === 'option-terminator') {
			terminated = true;
			continue;
		}
		if (token.kind === 'positional') {
			(terminated ? passthrough : positionals).push(token.value);
			continue;
		}
		applyOption(token, tokens[token.index], scope, values);
	}
	return { positionals, passthrough };
}

function checkPositionals(command: CommandSpec, positionals: string[]): void {
	const name = `cdk-blocks ${command.path.join(' ')}`;
	const args = command.args ?? [];
	const variadic = args.some((a) => a.variadic);
	if (positionals.length > args.length && !variadic) {
		const extra = positionals[args.length];
		const subcommands = subcommandsOf(command.path);
		if (subcommands.length > 0 && args.length === 0) {
			const asked = [...command.path, extra].join(' ');
			// `cdk-blocks dev --port 4000 stop`: the subcommand is right, the option is in the middle of it.
			if (findCommand([...command.path, extra])) {
				throw new UsageError(
					`"${extra}" must follow "${name}" directly: put the options of "cdk-blocks ${asked}" after the whole command.`,
					{ hint: blocksCommand(asked, '--help') },
				);
			}
			const candidates = subcommands.map((s) => s.path.join(' '));
			throw new UsageError(`unknown command "${asked}".${didYouMean(suggest(asked, candidates))}`, {
				hint: runnable(`${name} --help`),
			});
		}
		throw new UsageError(`unexpected argument "${extra}" for "${name}".`, { hint: runnable(`${name} --help`) });
	}
	const missing = args.find((a, i) => a.required && positionals[i] === undefined);
	if (missing) throw new UsageError(`"${name}" needs the <${missing.name}> argument.`, { hint: runnable(`${name} --help`) });
}

/** A command path word, and its argv index. */
interface PathWord {
	value: string;
	index: number;
}

/**
 * Check a `--query` path against the declared shape of a command's result.
 *
 * @throws {UsageError} When the result can never have the path: an unknown
 * field, a field of a plain value, or a list element not named by its index.
 */
function checkQueryPath(path: string, json: JsonObjectShape, name: string): void {
	let shape: JsonShape = json;
	const walked: string[] = [];
	for (const segment of path.split('.')) {
		const at = walked.join('.');
		let problem: string | undefined;
		if (shape === null) {
			problem = `${at} is a value, with no fields.`;
		} else if (Array.isArray(shape)) {
			if (/^(0|[1-9]\d*)$/.test(segment)) shape = (shape as readonly [JsonShape])[0];
			else problem = `${at} is a list; name an element by its index, as ${at}.0.`;
		} else {
			const fields = shape as JsonObjectShape;
			if (Object.hasOwn(fields, segment)) shape = fields[segment];
			else problem = `${at === '' ? 'Fields' : `Fields of ${at}`}: ${Object.keys(fields).join(', ')}.`;
		}
		if (problem) {
			throw new UsageError(`no field "${path}" in the result of ${name}. ${problem}`, {
				hint: runnable(`${name} --output json`),
			});
		}
		walked.push(segment);
	}
}

/**
 * Parse a full argv (without the node and script entries).
 *
 * @throws {UsageError} On an unknown command or option, a missing value or
 * argument, or an unexpected argument. The message suggests the closest name.
 */
export function parseArgv(argv: readonly string[]): ParsedInvocation {
	const values: FlagValues = {};
	// The global options before the command apply at once. The command path is up to three
	// words, with only global options between them; those apply once the path is known.
	const words: PathWord[] = [];
	const between: OptionToken[] = [];
	let leadingTerminator = false;
	for (const token of tokenize(argv, GLOBAL_FLAGS)) {
		if (token.kind === 'option-terminator') {
			if (words.length > 0 || leadingTerminator) break;
			leadingTerminator = true;
			continue;
		}
		if (token.kind === 'positional') {
			if (words.length === 3) break;
			words.push({ value: token.value, index: token.index });
			continue;
		}
		if (words.length === 0) {
			applyOption(token, argv[token.index], { specs: GLOBAL_FLAGS }, values);
			continue;
		}
		if (!GLOBAL_FLAGS.some((flag) => flag.name === token.name)) break;
		between.push(token);
	}

	if (words.length === 0) {
		const globals = toGlobals(values);
		if (!globals.help && !globals.version && (globals.output === 'json' || globals.query !== undefined)) {
			throw new UsageError(
				`${globals.query === undefined ? '--output json' : '--query'} needs a command whose result it prints.`,
				{ hint: blocksCommand('--help') },
			);
		}
		// `cdk-blocks --profile deploy`: the option took the command as its value, and nothing would run.
		const given = ['profile', 'region', 'cwd', 'telemetry-file'].filter((name) => typeof values[name] === 'string');
		if (!globals.help && !globals.version && given.length > 0) {
			const names = new Set([...nameIndex().keys()].map((key) => key.split(' ')[0]));
			const swallowed = given.find((name) => names.has(values[name] as string));
			throw new UsageError(
				swallowed
					? `no command given: --${swallowed} took "${values[swallowed]}" as its value.`
					: `no command given for --${given[0]}.`,
				{ hint: swallowed ? blocksCommand(`--${swallowed}`, `<${swallowed}>`, String(values[swallowed])) : blocksCommand('--help') },
			);
		}
		return { globals, flags: values, positionals: [], passthrough: [] };
	}

	const index = nameIndex();
	let match: IndexEntry | undefined;
	let used = 0;
	for (let n = words.length; n > 0 && !match; n--) {
		match = index.get(
			words
				.slice(0, n)
				.map((word) => word.value)
				.join(' '),
		);
		if (match) used = n;
	}
	if (!match) {
		const topLevel = [...index.keys()].filter((key) => !key.includes(' '));
		throw new UsageError(
			`unknown command "${words[0].value}".${didYouMean(suggestCommand(words[0].value, topLevel))}`,
			{
				hint: blocksCommand('--help'),
			},
		);
	}
	const last = words[used - 1].index;
	for (const token of between) {
		if (token.index < last) applyOption(token, argv[token.index], { specs: GLOBAL_FLAGS }, values);
	}

	let { command } = match;
	let tail = [...(match.alias?.args ?? []), ...argv.slice(last + 1)];
	let aliasName = match.alias?.name.join(' ');
	// A flag alias counts only before `--`: after it, the token is the user's argument.
	const end = tail.includes('--') ? tail.indexOf('--') : tail.length;
	const flagAlias = FLAG_ALIASES.find(
		(spec) => spec.command.join(' ') === command.path.join(' ') && tail.slice(0, end).includes(`--${spec.flag}`),
	);
	if (flagAlias) {
		const target = findCommand(flagAlias.target);
		if (!target) throw new Error(`flag alias --${flagAlias.flag} targets an unknown command`);
		const at = tail.indexOf(`--${flagAlias.flag}`);
		tail = [...tail.slice(0, at), ...tail.slice(at + 1)];
		aliasName = `${command.path.join(' ')} --${flagAlias.flag}`;
		command = target;
	}

	let parsed: ParsedInvocation;
	if (command.passthrough) {
		// `-h`/`--help` anywhere after a passthrough command means help, never a run
		// with the user's arguments: `cdk-blocks config remove KEY --help` must not delete KEY.
		const help = tail.some((token) => token === '-h' || token === '--help');
		const forwarded = liftGlobals(tail, values);
		if (help) values.help = true;
		parsed = {
			command,
			alias: aliasName,
			globals: toGlobals(values),
			flags: values,
			positionals: [],
			passthrough: help ? [] : forwarded,
			helpVerb: help ? tail.find((token) => command.verbs?.includes(token)) : undefined,
		};
	} else {
		const { positionals, passthrough } = parseCommandArgs(command, tail, values);
		parsed = { command, alias: aliasName, globals: toGlobals(values), flags: values, positionals, passthrough };
		// `cdk-blocks dev --port 4000 stop -h`: help for the subcommand the run would name, not for `cdk-blocks dev`.
		const subcommand =
			parsed.globals.help && !command.args?.length && positionals[0] !== undefined
				? findCommand([...command.path, positionals[0]])
				: undefined;
		if (subcommand) parsed.command = subcommand;
		if (!parsed.globals.help && !parsed.globals.version) {
			checkPositionals(command, positionals);
			// Only passthrough commands forward arguments after `--`; elsewhere they would be dropped.
			if (passthrough.length > 0) {
				throw new UsageError(`unexpected arguments after --: ${passthrough.join(' ')}`, {
					hint: blocksCommand(...command.path, '--help'),
				});
			}
		}
	}
	const { globals } = parsed;
	if (
		!globals.help &&
		!globals.version &&
		command.handler &&
		(globals.output === 'json' || globals.query !== undefined)
	) {
		const name = `cdk-blocks ${command.path.join(' ')}`;
		if (!command.json) {
			throw new UsageError(
				globals.query === undefined
					? `--output json is not supported for "${name}": it prints text only.`
					: `--query is not supported for "${name}": it has no JSON result.`,
				{ hint: runnable(`${name} --help`) },
			);
		}
		// Check the whole path before the command runs, so a typo never repeats a deploy.
		if (globals.query !== undefined) checkQueryPath(globals.query, command.json, name);
	}
	return parsed;
}
