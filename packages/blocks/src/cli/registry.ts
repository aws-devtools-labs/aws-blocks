// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The declarative command tree of the CDK Blocks task runner: groups, canonical names,
 * hidden aliases, descriptions, flags, examples and handlers.
 *
 * Command names are data. Renaming a command, or making an alias canonical,
 * is an edit here; the parser and the help read only this table.
 */

import { migrate } from './commands/migrate.js';
import * as commands from './commands.js';
import type { Context } from './context.js';
import { docs, docsForms } from './docs.js';

export type FlagType = 'boolean' | 'string' | 'optional-string';

export interface FlagSpec {
	/** The long name, without `--`. */
	name: string;
	/** A one-letter short name, without `-`. */
	short?: string;
	/** `optional-string` takes an inline value only: `--wait-live` or `--wait-live=120`. */
	type: FlagType;
	/** The value placeholder in help, for example `N`. */
	value?: string;
	description: string;
	/** Collect every occurrence into an array. */
	multiple?: boolean;
	/**
	 * A string option that people type as they would grep: grep's own flags or `--` right after it (`--search -i
	 * term`, `--search -- term`) are dropped, and the next argument is its value.
	 */
	grepHabits?: boolean;
	/**
	 * A string option given with no value at the end of the line (`ApiError --section`) means this boolean flag
	 * instead of an error: there is nothing it could have meant to take. The flag need not be one the command
	 * declares (docs' `--section` sets `toc`, the headings, which has no option of its own).
	 */
	bare?: string;
}

export interface ArgSpec {
	name: string;
	description: string;
	required?: boolean;
	/** Takes the remaining positionals. */
	variadic?: boolean;
}

/** Root help groups, in display order. */
export const GROUPS = ['Develop', 'Deploy', 'Configure', 'Generate', 'Data and blocks', 'Project'] as const;
export type HelpGroup = (typeof GROUPS)[number];

export type FlagValues = Record<string, string | boolean | string[] | undefined>;

/**
 * The shape of a JSON result, so that a `--query` path is checked before the
 * command runs: `null` for a value, an object's fields, or a one-element
 * array for a list whose elements have that shape. An object whose field
 * names are data (script names) declares the shape of every field as `'*'`.
 */
export type JsonShape = null | readonly [JsonShape] | JsonObjectShape;
export interface JsonObjectShape {
	readonly [field: string]: JsonShape;
}

export interface CommandInput {
	flags: FlagValues;
	positionals: string[];
	/** For a passthrough command, every token after the command; otherwise the tokens after `--`. */
	passthrough: string[];
}

export type Handler = (ctx: Context, input: CommandInput) => Promise<number>;

export interface Example {
	command: string;
	description: string;
}

export interface CommandSpec {
	/** The canonical path, for example `['sandbox', 'destroy']`. */
	path: readonly string[];
	group: HelpGroup;
	summary: string;
	/** Longer help text; defaults to the summary. */
	description?: string;
	args?: ArgSpec[];
	flags?: FlagSpec[];
	examples?: Example[];
	/**
	 * Forward every token after the command verbatim. A `-h`/`--help` anywhere
	 * after it never runs the tool with the user's arguments: it shows help instead.
	 */
	passthrough?: boolean;
	/**
	 * The verbs of a passthrough tool that print their own help. Help for one of
	 * them forwards only `<verb> --help` (never the other arguments) to the tool,
	 * which prints that verb's usage without side effects.
	 */
	verbs?: readonly string[];
	/**
	 * Arguments after `--` are more positional arguments, as `--` means in POSIX (`npm run docs -- --exports --
	 * schema`), rather than an error. Only for a command whose positionals are names, never flags it forwards.
	 */
	operandsAfterDashDash?: boolean;
	/** The shape of the `--output json` result; absent when the command has no JSON output. */
	json?: JsonObjectShape;
	/**
	 * The command calls AWS or deploys to it, so an inherited AWS_REGION must be a
	 * Region code. An explicit `--region` is checked for every command.
	 */
	aws?: boolean;
	/** Absent for a command group, which prints its help and exits 2. */
	handler?: Handler;
}

export interface AliasSpec {
	/** The alias tokens, for example `['dev:stop']`. */
	name: readonly string[];
	/** The canonical path it runs. */
	target: readonly string[];
	/** Arguments inserted before the user's own, for example `['--all']`. */
	args?: readonly string[];
}

/** A hidden flag spelling retained by the internal sandbox command parser. */
export interface FlagAliasSpec {
	/** The command the flag is given to. */
	command: readonly string[];
	/** The flag, without `--`. It takes no value. */
	flag: string;
	/** The canonical path it runs. */
	target: readonly string[];
}

/** Options accepted at every level. `-v` is `--verbose`; `--version` is long-only. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
	{ name: 'help', short: 'h', type: 'boolean', description: 'Show help for the current command level' },
	{ name: 'version', type: 'boolean', description: 'Print the aws-cdk-blocks version' },
	{ name: 'quiet', short: 'q', type: 'boolean', description: 'Errors and final results only' },
	{ name: 'verbose', short: 'v', type: 'boolean', description: 'Include raw output from CDK and child tools' },
	{ name: 'debug', type: 'boolean', description: 'Verbose, plus stack traces and internal diagnostics' },
	{
		name: 'output',
		type: 'string',
		value: 'text|json',
		description: 'Result format: text on a terminal, JSON on a pipe for tasks with a structured result',
	},
	{ name: 'yes', short: 'y', type: 'boolean', description: 'Assume yes for confirmations' },
	{
		name: 'no-input',
		type: 'boolean',
		description: 'Never prompt; implied when stdin is not a TTY or CI is set',
	},
	{
		name: 'query',
		type: 'string',
		value: 'path',
		description: 'Print one field of the JSON result, raw (for example: --query apiUrl)',
	},
	{ name: 'profile', type: 'string', value: 'name', description: 'AWS profile; sets AWS_PROFILE for the run' },
	{ name: 'region', type: 'string', value: 'region', description: 'AWS Region; sets AWS_REGION for the run' },
	{ name: 'cwd', short: 'C', type: 'string', value: 'dir', description: 'Run as if started in <dir>' },
	{
		name: 'telemetry-file',
		type: 'string',
		value: 'path',
		description: "Also write the run's telemetry events to <path>",
	},
];

const STAGE_HELP =
	'--stage <name> takes any name; there is no fixed list. A value set with --stage <name> is\n' +
	'stored at <prefix>/<name>/<KEY>, and the app reads it only when its Hosting %STORE% sets\n' +
	"stage: '<name>'. Without --stage, the value is shared: every stage falls back to it.";

/** The deploy result: `{apiUrl, url, stack, account, region}`. */
const DEPLOY_RESULT: JsonObjectShape = { apiUrl: null, url: null, stack: null, account: null, region: null };

/** A doc, or the part of one, in a `docs` answer, and a `--search` hit. */
const DOC_PART: JsonObjectShape = {
	doc: null,
	section: null,
	lines: [null],
	note: null,
	text: null,
	headings: [{ level: null, title: null, slug: null, lines: [null] }],
};
const DOCS_HIT: JsonObjectShape = { doc: null, line: null, section: null, text: null };
const DOCS_EXPORT: JsonObjectShape = {
	name: null,
	kind: null,
	package: null,
	entry: null,
	import: null,
	also: [null],
	original: null,
};
/** What `docs` answers for one name: a block's docs, a name's card, or an entry's names. */
const DOCS_ANSWER: JsonObjectShape = {
	docs: [DOC_PART],
	name: null,
	kind: null,
	of: [null],
	package: null,
	import: null,
	declaration: null,
	summary: null,
	mentions: [DOCS_HIT],
	also: [null],
	notes: [null],
	names: [DOCS_EXPORT],
};
/** Every form of the `docs` answer: the listing, `--exports`, `--search`, one name, or several (`answers`). */
const DOCS_RESULT: JsonObjectShape = {
	...DOCS_ANSWER,
	version: null,
	blocks: [{ name: null, classes: [null], summary: null, doc: null, files: [null] }],
	framework: [{ name: null, summary: null, doc: null }],
	term: null,
	hits: [DOCS_HIT],
	total: null,
	files: null,
	lookup: DOCS_ANSWER,
	answers: [DOCS_ANSWER],
};

export const COMMANDS: readonly CommandSpec[] = [
	// ── Develop ──────────────────────────────────────────────────────────────
	{
		path: ['dev'],
		group: 'Develop',
		summary: 'Run the app locally, with reload; no AWS',
		description:
			'Run the app locally against local mocks, with reload on save. No AWS account is needed.\n' +
			'The frontend command comes from package.json "blocks.dev", or is detected from next, nuxt, astro or vite.',
		flags: [
			{
				name: 'port',
				type: 'string',
				value: 'N',
				description: 'Port you open in the browser (serves the app and proxies the frontend) [3000]',
			},
			{
				name: 'host',
				type: 'string',
				value: 'host',
				description: 'Interface to bind (default: 127.0.0.1)',
			},
			{
				name: 'frontend-command',
				type: 'string',
				value: 'cmd',
				description: 'Command that starts the frontend dev server',
			},
			{
				name: 'frontend-port',
				type: 'string',
				value: 'N',
				description: 'Internal port of the frontend dev server, proxied behind --port [3100]',
			},
			{ name: 'no-frontend', type: 'boolean', description: 'Run the backend only' },
		],
		examples: [
			{ command: 'npm run dev', description: 'open http://localhost:3000' },
			{ command: 'npm run dev -- --port 4000', description: 'open http://localhost:4000' },
			{ command: 'npm run dev -- --no-frontend', description: 'backend only' },
		],
		handler: commands.dev,
	},
	{
		path: ['dev', 'stop'],
		group: 'Develop',
		summary: 'Stop the local dev server this app started',
		description:
			'Stop the local dev server that this app started on the port. It acts only on the process\n' +
			'that the dev server recorded for itself, never on another process that holds the port.\n' +
			'Without --port, when nothing is recorded on the configured port but exactly one dev server\n' +
			'is recorded on another (npm run dev -- --port N), it stops that one.',
		flags: [
			{
				name: 'port',
				type: 'string',
				value: 'N',
				description: 'Port of the dev server to stop [the "npm run dev" port]',
			},
			{ name: 'all', type: 'boolean', description: 'Stop every dev server this app recorded, on any port' },
		],
		json: {
			stopped: [
				{ port: null, stopped: null, alreadyStopped: null, portFree: null, via: null, holders: [{ pid: null, command: null }] },
			],
		},
		examples: [
			{ command: 'npm run dev:stop', description: 'Stop the dev server on the configured port' },
			{ command: 'npm run dev:stop -- --all', description: 'Stop every dev server this app started' },
		],
		handler: commands.devStop,
	},
	{
		path: ['sandbox'],
		group: 'Develop',
		summary: 'Deploy your personal sandbox, watch for changes, and run the local server against it',
		description:
			'Deploy your personal sandbox stack, then watch for changes and run the local server\n' +
			'against it. Ctrl-C stops the local processes; the stack keeps running until you\n' +
			'run "npm run sandbox:destroy".',
		examples: [{ command: 'npm run sandbox', description: 'Deploy and watch your sandbox' }],
		aws: true,
		handler: commands.sandbox,
	},
	{
		path: ['sandbox', 'deploy'],
		group: 'Develop',
		summary: 'Deploy the sandbox once and exit (CI)',
		json: DEPLOY_RESULT,
		examples: [
			{ command: 'npm run sandbox:deploy', description: 'Deploy once and exit' },
			{
				command: 'API_URL=$(npm run -s sandbox:deploy -- --query apiUrl)',
				description: 'Deploy, then keep the API URL in a shell variable',
			},
		],
		aws: true,
		handler: commands.sandboxDeploy,
	},
	{
		path: ['sandbox', 'preview'],
		group: 'Develop',
		summary: 'Deploy the sandbox with a hosted preview of the frontend once and exit',
		description:
			'Deploy your sandbox with the app hosted in preview shape (API Gateway, no CloudFront), print\n' +
			'the preview URL, and exit. It is the same stack as "npm run sandbox": a plain sandbox deploy\n' +
			'removes the preview, and re-adding it gives a new URL. A re-deploy hotswaps a code-only change.',
		json: DEPLOY_RESULT,
		examples: [
			{ command: 'npm run sandbox:preview', description: 'Deploy a hosted preview and print its URL' },
			{
				command: 'URL=$(npm run -s sandbox:preview -- --query url)',
				description: 'Deploy, then keep the preview URL in a shell variable',
			},
		],
		aws: true,
		handler: commands.sandboxPreview,
	},
	{
		path: ['sandbox', 'destroy'],
		group: 'Develop',
		summary: 'Delete your sandbox stack (never production)',
		description:
			'Delete your personal sandbox stack. This never touches the production stack.\n' +
			'In an interactive terminal it asks first; --yes skips the question.',
		examples: [{ command: 'npm run sandbox:destroy -- --yes', description: 'Delete the sandbox without asking' }],
		aws: true,
		handler: commands.sandboxDestroy,
	},
	{
		path: ['sandbox', 'console'],
		group: 'Develop',
		summary: 'Open the AWS console for the sandbox stack',
		examples: [{ command: 'npm run sandbox:console', description: 'Open the CloudFormation console' }],
		aws: true,
		handler: commands.sandboxConsole,
	},
	{
		path: ['docs'],
		group: 'Develop',
		summary: 'Read the CDK Blocks docs: a block, an export or option, one section, or a search',
		description: [
			'Print the docs that ship in aws-cdk-blocks, looked up by name.',
			'',
			...docsForms('npm run docs'),
			'',
			'Every printed doc starts with "# <folder>/<file>" (# bb-kv-store/README.md, # README.md), and that doc',
			'path prints the file again (npm run docs bb-cron-job/DESIGN.md). guide is the package README and',
			'troubleshooting its TROUBLESHOOTING.md.',
			'',
			'Structured output defaults to JSON on a pipe and Markdown on a terminal. Use --output text for Markdown',
			'on a pipe, or --output json for JSON on a terminal. Each doc is named by "doc": "<folder>/<file>":',
			'  no name     {version, blocks: [{name, classes, summary, doc, files}], framework: [{name, summary, doc}]}',
			'  a block     {docs: [{doc, lines, text}]}; with --section, each part also has its section',
			'  a name      {name, kind, package, import, declaration, summary, docs: [{doc, section, lines, text}]}',
			'  --exports   {names: [{name, kind, package, entry, import, also}]}',
			'  --search    {term, hits: [{doc, line, section, text}], total, files}',
			'Several names print {answers: [...]}, one per name. Errors stay text on stderr.',
		].join('\n'),
		args: [
			{
				name: 'name',
				description: 'A block, an export, an option, Owner.member, a doc path, guide or troubleshooting',
				variadic: true,
			},
		],
		flags: [
			{
				name: 'api',
				type: 'boolean',
				description: "The block's API report (exact signatures) instead of its README",
			},
			{
				name: 'section',
				type: 'string',
				value: 'topic',
				multiple: true,
				bare: 'toc',
				description: 'The part of the docs about a topic; repeatable; with no topic, the headings',
			},
			{
				name: 'exports',
				type: 'boolean',
				description:
					'The names aws-cdk-blocks and its entries export, and which entry to use; names after it filter the list',
			},
			{
				name: 'search',
				type: 'string',
				value: 'term',
				grepHabits: true,
				description: 'Matching lines in every doc, or in the named blocks, with their section',
			},
		],
		examples: [
			{ command: 'npm run docs', description: 'The blocks, their classes and what each does' },
			{ command: 'npm run docs KVStore core', description: 'Two READMEs in one call' },
			{ command: 'npm run docs:api KVStore', description: 'Its exact signatures' },
			{ command: 'npm run docs ifFieldEquals', description: 'Where an option is declared and documented' },
			{ command: 'npm run docs Secret.get', description: 'A member of an export' },
			{ command: 'npm run docs KVStore -- --section query', description: 'The part about queries' },
			{ command: 'npm run docs KVStore -- --section local', description: 'How it behaves locally' },
			{ command: 'npm run docs -- --exports Error', description: 'Importable names containing "Error"' },
			{ command: 'npm run docs:search ConditionalCheckFailed', description: 'Search every doc' },
			{ command: 'npm run -s docs ApiError -- --output json', description: 'The same answer as JSON' },
		],
		json: DOCS_RESULT,
		operandsAfterDashDash: true,
		handler: docs,
	},
	// ── Deploy ───────────────────────────────────────────────────────────────
	{
		path: ['deploy'],
		group: 'Deploy',
		summary: 'Deploy the production stack',
		description:
			'Deploy the production stack. The target (stack, Region, credentials) is printed first.\n' +
			'With --output json, stdout carries one document: {apiUrl, url, stack, account, region}.',
		flags: [
			{
				name: 'wait-live',
				type: 'optional-string',
				value: 'SECONDS',
				description: 'Wait until CloudFront serves the new build (optional budget, default 180)',
			},
			{
				name: 'wait-live-timeout',
				type: 'string',
				value: 'SECONDS',
				description: 'Budget for --wait-live, in seconds (1-3600)',
			},
		],
		json: { ...DEPLOY_RESULT, live: null },
		examples: [
			{ command: 'npm run deploy', description: 'Deploy to production' },
			{
				command: 'npm run deploy -- --wait-live=300',
				description: 'Deploy, then wait up to 300s for the new build',
			},
			{ command: 'npm run -s deploy -- --output json', description: 'Print {apiUrl, url, stack, account, region}' },
			{ command: 'API_URL=$(npm run -s deploy -- --query apiUrl)', description: 'Print only the API URL, raw' },
		],
		aws: true,
		handler: commands.deploy,
	},
	{
		path: ['destroy'],
		group: 'Deploy',
		summary: 'Delete the production stack',
		description:
			'Delete the production stack. The target is printed first. In an interactive terminal it\n' +
			'asks for confirmation; without a terminal it requires --yes and exits 2 otherwise.',
		examples: [
			{ command: 'npm run destroy', description: 'Delete production, after a confirmation' },
			{ command: 'npm run destroy -- --yes', description: 'Delete production without asking (CI)' },
		],
		aws: true,
		handler: commands.destroy,
	},
	{
		path: ['whoami'],
		group: 'Deploy',
		summary: 'Show the AWS identity, Region and the stacks that commands would affect',
		description:
			'Show the AWS identity, the Region, and the sandbox and production stacks that\n' +
			'"npm run sandbox" and "npm run deploy" would affect. Nothing is deployed.\n' +
			'The identity and Region are the ones "npm run deploy" uses, with .env.production\n' +
			'applied. A warning names the AWS settings that .env.local sets differently\n' +
			'for the sandbox.',
		json: {
			account: null,
			arn: null,
			credentials: null,
			region: null,
			projectRoot: null,
			stacks: { sandbox: null, production: null },
		},
		examples: [
			{ command: 'npm run whoami', description: 'Show the deployment target' },
			{ command: 'npm run -s whoami -- --profile prod --output json', description: 'The same, as JSON' },
			{ command: 'npm run -s whoami -- --query stacks.production', description: 'Print the production stack name' },
		],
		aws: true,
		handler: commands.whoami,
	},
	// ── Configure ────────────────────────────────────────────────────────────
	{
		path: ['secret'],
		group: 'Configure',
		summary: 'Manage secrets: set KEY, list, remove KEY',
		description:
			'Manage secrets. The tokens after "secret" are forwarded unchanged, except the global options\n' +
			'(--profile, --output, …) before a "--". A secret value is never\n' +
			'accepted on the command line: pipe it with --value-stdin, or omit it to be prompted.\n' +
			'Flags: --stage <name>, --value-stdin, --region <name>, --prefix <path>, --force, --yes.\n' +
			'"npm run secret <set|list|remove> -- --help" shows the flags of one subcommand.\n' +
			STAGE_HELP.replace('%STORE%', 'secretStore'),
		args: [{ name: 'subcommand', description: 'set KEY | list | remove KEY', variadic: true }],
		passthrough: true,
		verbs: ['set', 'list', 'remove', 'rm'],
		examples: [
			{ command: 'npm run secret set API_KEY', description: 'Set API_KEY (prompts for the value)' },
			{ command: 'cat key.txt | npm run -s secret set API_KEY -- --value-stdin', description: 'Set it from stdin' },
			{
				command: 'npm run secret set API_KEY -- --stage prod',
				description: "only for an app whose Hosting secretStore sets stage: 'prod'",
			},
		],
		aws: true,
		handler: commands.secret,
	},
	{
		path: ['config'],
		group: 'Configure',
		summary: 'Manage non-secret config: set KEY VALUE, list, remove KEY',
		description:
			'Manage non-secret config values. The tokens after "config" are forwarded unchanged, except\n' +
			'the global options (--profile, --output, …) before a "--"; put a value that starts with "-" after "--".\n' +
			'Flags: --stage <name>, --value-stdin, --region <name>, --prefix <path>.\n' +
			'"npm run config <set|list|remove> -- --help" shows the flags of one subcommand.\n' +
			STAGE_HELP.replace('%STORE%', 'configStore'),
		args: [{ name: 'subcommand', description: 'set KEY VALUE | list | remove KEY', variadic: true }],
		passthrough: true,
		verbs: ['set', 'list', 'remove', 'rm'],
		examples: [
			{ command: 'npm run config set FEATURE_FLAG on', description: 'Set FEATURE_FLAG' },
			{ command: 'npm run config list', description: 'List config values' },
		],
		aws: true,
		handler: commands.config,
	},
	// ── Generate ─────────────────────────────────────────────────────────────
	{
		path: ['generate'],
		group: 'Generate',
		summary: 'Generate the typed client, the OpenRPC spec or key types',
	},
	{
		path: ['generate', 'client'],
		group: 'Generate',
		summary: 'Generate the typed client',
		args: [
			{ name: 'foundation', description: 'Backend entry (default: cdk-blocks/index.ts)' },
			{ name: 'output', description: 'Output file (default: cdk-blocks/client.js)' },
		],
		flags: [
			{
				name: 'force',
				type: 'boolean',
				description:
					'Write cdk-blocks/client.js even when package.json sets "blocks.dev.generateClient": false',
			},
		],
		examples: [{ command: 'npm run generate-client', description: 'Write cdk-blocks/client.js' }],
		handler: commands.generateClient,
	},
	{
		path: ['generate', 'spec'],
		group: 'Generate',
		summary: 'Generate the OpenRPC spec',
		args: [
			{ name: 'backend', description: 'Backend entry (default: cdk-blocks/index.ts)' },
			{ name: 'output', description: 'Output file (default: blocks.spec.json next to the backend)' },
		],
		examples: [{ command: 'npm run spec', description: 'Write cdk-blocks/blocks.spec.json' }],
		handler: commands.generateSpec,
	},
	{
		path: ['generate', 'types'],
		group: 'Generate',
		summary: 'Generate secret/config key types; --check exits 1 when stale',
		flags: [
			{ name: 'check', type: 'boolean', description: 'Exit 1 when the generated types are stale (CI)' },
			{ name: 'watch', short: 'w', type: 'boolean', description: 'Regenerate on change' },
			{ name: 'out', type: 'string', value: 'path', description: 'Output .d.ts path' },
			{ name: 'include', type: 'string', value: 'glob', multiple: true, description: 'Source glob to scan' },
			{ name: 'module', type: 'string', value: 'spec', multiple: true, description: 'Module to augment' },
		],
		examples: [
			{ command: 'npm run typegen', description: 'Regenerate the key types' },
			{ command: 'npm run typegen -- --check', description: 'Fail when they are stale' },
		],
		handler: commands.generateTypes,
	},
	// ── Data and blocks ──────────────────────────────────────────────────────
	{
		path: ['db'],
		group: 'Data and blocks',
		summary: 'The database of a Database block: connect, migrate, types, status',
		description:
			'Work with the existing PostgreSQL database of a Database block (DatabaseCluster.fromExisting()):\n' +
			'connect, migrate, types, status. For a block that provisions its cluster, "types --block <id>" and\n' +
			'"status --block <id>" work from its migration files and its local database.\n' +
			'The verb and its arguments go to the bb-database CLI of @aws-cdk-blocks/bb-database. After npm’s separator,\n' +
			'global options (--profile, --yes, …) apply before a second "--"; --yes and --no-input are passed on.\n' +
			'For JSON output give the option to the tool: "npm run -s db -- status -- --output json".\n' +
			'"npm run db -- <verb> --help" shows its options.',
		args: [
			{ name: 'verb', description: 'connect | migrate | types | status', required: true },
			{ name: 'args', description: 'Relative paths start at the task’s working directory (or -C)', variadic: true },
		],
		passthrough: true,
		verbs: ['connect', 'migrate', 'types', 'status'],
		examples: [
			{
				command: 'npm run db -- connect --ca ./prod-ca-2021.crt',
				description: 'Check the database and store its connection string for local mode',
			},
			{
				command: 'npm run db -- connect --stage production --ca ./prod-ca-2021.crt',
				description: 'The same for the production stage',
			},
			{ command: 'npm run db migrate', description: 'Apply ./migrations to the local database, then write the types' },
			{ command: 'npm run db -- status --stage production', description: 'Show applied and pending migrations' },
			{
				command: 'npm run db -- types --block main',
				description: 'Write the Kysely types of the block "main" from its migration files',
			},
			{
				command: 'npm run db -- migrate --mark-applied 000_baseline.sql',
				description: 'Record a schema dump of the database as applied, without running it',
			},
		],
		aws: true,
		handler: commands.db,
	},
	// ── Project ──────────────────────────────────────────────────────────────
	{
		path: ['vendorize'],
		group: 'Project',
		summary: 'Copy a Building Block into the app for customization',
		args: [
			{ name: 'package', description: 'For example @aws-cdk-blocks/bb-kv-store', required: true },
			{ name: 'options', description: '--force overwrites an existing copy', variadic: true },
		],
		passthrough: true,
		examples: [
			{ command: 'npm run vendorize @aws-cdk-blocks/bb-kv-store', description: 'Copy KVStore into the app' },
		],
		handler: commands.vendorize,
	},
	{
		path: ['migrate'],
		group: 'Project',
		summary: 'Move an app from generated wrapper scripts to package-manager tasks',
		description:
			'Move an app from create-blocks-app wrappers (cdk-blocks/scripts/*.ts) to package-manager tasks.\n' +
			'Scripts whose value is exactly a generated command (for example "tsx cdk-blocks/scripts/deploy.ts")\n' +
			'are rewritten; missing framework tasks are added without overwriting custom scripts. The options of a\n' +
			'generated server.ts move to package.json "blocks.dev". Generated wrappers that no script and no\n' +
			'app file other than Markdown docs uses any more are deleted. Only the wrappers of public\n' +
			'create-blocks-app releases are recognised; any other version is reported as unrecognised and is\n' +
			'never deleted. In a git repository the app files are the tracked and not-ignored ones,\n' +
			'and the files of a submodule or nested repository inside the app; outside git, or where git does\n' +
			'not track the app, the files under the app directory other than node_modules and build output.\n' +
			'In a monorepo, and in the superproject of a submodule, it also reads every tracked package.json\n' +
			'and CI, shell, Make and Docker file outside the app (.github/workflows/*, scripts/*.sh,\n' +
			'ci/Makefile); there a path counts only with the directory of this app\n' +
			'(apps/web/cdk-blocks/scripts/deploy.ts), or in a file that changes into the app\n' +
			'(working-directory: apps/web, cd apps/web). In CI, shell and Docker files and in scripts, a bare\n' +
			'scripts/deploy.ts or deploy.ts counts as a use too.\n' +
			'Unless you pass --force, it refuses an app outside git (or without git installed), a git working\n' +
			'tree with uncommitted changes, an app that git does not track (a parent repository ignores its\n' +
			'directory), since git could not undo the changes, and a repository that git fails to read. Run\n' +
			'--dry-run first to see the plan.\n' +
			'Exit codes:\n' +
			'  0  fully migrated, or nothing to do\n' +
			'  1  kept items remain for you to finish by hand (a report, not a crash), or migrate refused and\n' +
			'     wrote nothing; in JSON mode a refusal prints {"error": {"message", "hint"}} on stdout\n' +
			'     instead of the result (with --query, only the error on stderr), as it does for wrappers it\n' +
			'     could not delete after rewriting package.json (fix them, then run it again with --force)\n' +
			'  2  usage error',
		flags: [
			{ name: 'dry-run', type: 'boolean', description: 'Print the plan; write nothing' },
			{
				name: 'force',
				type: 'boolean',
				description:
					'Run outside git, with uncommitted changes, or where git does not track the app or fails to read it',
			},
		],
		json: {
			changed: [null],
			removed: [null],
			kept: [{ file: null, reason: null }],
			scriptsRewritten: { '*': { from: null, to: null } },
			devConfig: { port: null, frontendCommand: null, frontendPort: null, frontend: null, generateClient: null },
		},
		examples: [
			{ command: 'npm run migrate -- --dry-run', description: 'Show what would change' },
			{ command: 'npm run migrate', description: 'Rewrite the scripts and delete the generated wrappers' },
			{
				command: 'npm run -s migrate -- --output json',
				description: 'Print {changed, removed, kept, scriptsRewritten, devConfig} (added scripts have from: null)',
			},
		],
		handler: migrate,
	},
	{
		path: ['help'],
		group: 'Project',
		summary: 'Show help for a command',
		args: [{ name: 'command', description: 'For example "sandbox:destroy"', variadic: true }],
		examples: [
			{ command: 'npm run sandbox:destroy -- --help', description: 'Help for "npm run sandbox:destroy"' },
		],
		handler: commands.help,
	},
];

/** Internal aliases accepted by the parser; task names are rendered separately. */
export const ALIASES: readonly AliasSpec[] = [
	{ name: ['dev:stop'], target: ['dev', 'stop'] },
	{ name: ['cleanup'], target: ['dev', 'stop'], args: ['--all'] },
	{ name: ['sandbox', 'up'], target: ['sandbox'] },
	{ name: ['sandbox:deploy'], target: ['sandbox', 'deploy'] },
	{ name: ['sandbox:preview'], target: ['sandbox', 'preview'] },
	{ name: ['sandbox:destroy'], target: ['sandbox', 'destroy'] },
	{ name: ['sandbox:console'], target: ['sandbox', 'console'] },
	{ name: ['console'], target: ['sandbox', 'console'] },
	{ name: ['typegen'], target: ['generate', 'types'] },
	{ name: ['generate-client'], target: ['generate', 'client'] },
	{ name: ['spec'], target: ['generate', 'spec'] },
];

/** Hidden flag aliases, for the flags of the scripts that the npm scripts ran before the CLI. */
export const FLAG_ALIASES: readonly FlagAliasSpec[] = [
	{ command: ['sandbox'], flag: 'deploy-only', target: ['sandbox', 'deploy'] },
	{ command: ['sandbox'], flag: 'preview', target: ['sandbox', 'preview'] },
];

/** The canonical command for a path, if any. */
export function findCommand(path: readonly string[]): CommandSpec | undefined {
	const key = path.join(' ');
	return COMMANDS.find((command) => command.path.join(' ') === key);
}

/** The direct subcommands of a command path. */
export function subcommandsOf(path: readonly string[]): CommandSpec[] {
	const prefix = path.join(' ');
	return COMMANDS.filter(
		(command) => command.path.length === path.length + 1 && command.path.slice(0, -1).join(' ') === prefix,
	);
}
