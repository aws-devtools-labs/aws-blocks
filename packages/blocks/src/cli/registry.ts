// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The declarative command tree of the `blocks` CLI: groups, canonical names,
 * hidden aliases, descriptions, flags, examples and handlers.
 *
 * Command names are data. Renaming a command, or making an alias canonical,
 * is an edit here; the parser and the help read only this table.
 */

import * as commands from './commands.js';
import type { Context } from './context.js';

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
	/** The top-level fields of the `--output json` result; absent when the command has no JSON output. */
	json?: readonly string[];
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

/** A hidden flag spelling of another command: `blocks sandbox --deploy-only` runs `blocks sandbox deploy`. */
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
	{ name: 'version', type: 'boolean', description: 'Print the @aws-blocks/blocks version' },
	{ name: 'quiet', short: 'q', type: 'boolean', description: 'Errors and final results only' },
	{ name: 'verbose', short: 'v', type: 'boolean', description: 'Include raw output from CDK and child tools' },
	{ name: 'debug', type: 'boolean', description: 'Verbose, plus stack traces and internal diagnostics' },
	{
		name: 'output',
		type: 'string',
		value: 'text|json',
		description: 'Result format on stdout; json prints one JSON document, progress stays on stderr',
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

/** The fields of the deploy result: `{apiUrl, url, stack, account, region}`. */
const DEPLOY_RESULT_FIELDS = ['apiUrl', 'url', 'stack', 'account', 'region'] as const;

export const COMMANDS: readonly CommandSpec[] = [
	// ── Develop ──────────────────────────────────────────────────────────────
	{
		path: ['dev'],
		group: 'Develop',
		summary: 'Run the app locally, with reload; no AWS',
		description:
			'Run the app locally against local mocks, with reload on save. No AWS account is needed.\n' +
			'The frontend command comes from package.json "blocks.dev", or is detected from vite or next.',
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
			{ command: 'blocks dev', description: 'open http://localhost:3000' },
			{ command: 'blocks dev --port 4000', description: 'open http://localhost:4000' },
			{ command: 'blocks dev --no-frontend', description: 'backend only' },
		],
		handler: commands.dev,
	},
	{
		path: ['dev', 'stop'],
		group: 'Develop',
		summary: 'Stop the local dev server this app started',
		description:
			'Stop the local dev server that this app started on the port. It acts only on the process\n' +
			'that the dev server recorded for itself, never on another process that holds the port.',
		flags: [
			{
				name: 'port',
				type: 'string',
				value: 'N',
				description: 'Port of the dev server to stop [the "blocks dev" port]',
			},
			{ name: 'all', type: 'boolean', description: 'Stop every dev server this app recorded, on any port' },
		],
		json: ['stopped'],
		examples: [
			{ command: 'blocks dev stop', description: 'Stop the dev server on the configured port' },
			{ command: 'blocks dev stop --all', description: 'Stop every dev server this app started' },
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
			'run "blocks sandbox destroy".',
		examples: [{ command: 'blocks sandbox', description: 'Deploy and watch your sandbox' }],
		aws: true,
		handler: commands.sandbox,
	},
	{
		path: ['sandbox', 'deploy'],
		group: 'Develop',
		summary: 'Deploy the sandbox once and exit (CI)',
		json: DEPLOY_RESULT_FIELDS,
		examples: [
			{ command: 'blocks sandbox deploy', description: 'Deploy once and exit' },
			{
				command: 'API_URL=$(blocks sandbox deploy --query apiUrl)',
				description: 'Deploy, then keep the API URL in a shell variable',
			},
		],
		aws: true,
		handler: commands.sandboxDeploy,
	},
	{
		path: ['sandbox', 'destroy'],
		group: 'Develop',
		summary: 'Delete your sandbox stack (never production)',
		description:
			'Delete your personal sandbox stack. This never touches the production stack.\n' +
			'In an interactive terminal it asks first; --yes skips the question.',
		examples: [{ command: 'blocks sandbox destroy --yes', description: 'Delete the sandbox without asking' }],
		aws: true,
		handler: commands.sandboxDestroy,
	},
	{
		path: ['sandbox', 'console'],
		group: 'Develop',
		summary: 'Open the AWS console for the sandbox stack',
		examples: [{ command: 'blocks sandbox console', description: 'Open the CloudFormation console' }],
		aws: true,
		handler: commands.sandboxConsole,
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
		json: DEPLOY_RESULT_FIELDS,
		examples: [
			{ command: 'blocks deploy', description: 'Deploy to production' },
			{ command: 'blocks deploy --wait-live=300', description: 'Deploy, then wait up to 300s for the new build' },
			{ command: 'blocks deploy --output json', description: 'Print {apiUrl, url, stack, account, region}' },
			{ command: 'API_URL=$(blocks deploy --query apiUrl)', description: 'Print only the API URL, raw' },
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
			{ command: 'blocks destroy', description: 'Delete production, after a confirmation' },
			{ command: 'blocks destroy --yes', description: 'Delete production without asking (CI)' },
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
			'"blocks sandbox" and "blocks deploy" would affect. Nothing is deployed.\n' +
			'The identity and Region are the ones "blocks deploy" uses, with .env.production\n' +
			'applied. A warning names the AWS settings that .env.local sets differently\n' +
			'for the sandbox.',
		json: ['account', 'arn', 'credentials', 'region', 'projectRoot', 'stacks'],
		examples: [
			{ command: 'blocks whoami', description: 'Show the deployment target' },
			{ command: 'blocks whoami --profile prod --output json', description: 'The same, as JSON' },
			{ command: 'blocks whoami --query stacks.production', description: 'Print the production stack name' },
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
			'Manage secrets. Everything after "secret" is forwarded unchanged. A secret value is never\n' +
			'accepted on the command line: pipe it with --value-stdin, or omit it to be prompted.\n' +
			'Flags: --stage <name>, --value-stdin, --region <name>, --prefix <path>, --force, --yes.\n' +
			'"blocks secret <set|list|remove> --help" shows the flags of one subcommand.\n' +
			STAGE_HELP.replace('%STORE%', 'secretStore'),
		args: [{ name: 'subcommand', description: 'set KEY | list | remove KEY', variadic: true }],
		passthrough: true,
		verbs: ['set', 'list', 'remove', 'rm'],
		examples: [
			{ command: 'blocks secret set API_KEY', description: 'Set API_KEY (prompts for the value)' },
			{ command: 'cat key.txt | blocks secret set API_KEY --value-stdin', description: 'Set it from stdin' },
			{
				command: 'blocks secret set API_KEY --stage prod',
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
			'Manage non-secret config values. Everything after "config" is forwarded unchanged.\n' +
			'Flags: --stage <name>, --value-stdin, --region <name>, --prefix <path>.\n' +
			'"blocks config <set|list|remove> --help" shows the flags of one subcommand.\n' +
			STAGE_HELP.replace('%STORE%', 'configStore'),
		args: [{ name: 'subcommand', description: 'set KEY VALUE | list | remove KEY', variadic: true }],
		passthrough: true,
		verbs: ['set', 'list', 'remove', 'rm'],
		examples: [
			{ command: 'blocks config set FEATURE_FLAG on', description: 'Set FEATURE_FLAG' },
			{ command: 'blocks config list', description: 'List config values' },
		],
		aws: true,
		handler: commands.config,
	},
	{
		path: ['telemetry'],
		group: 'Configure',
		summary: 'Show or change telemetry consent',
		description:
			'Show or change telemetry consent for this project, or for every project with --global.\n' +
			'Also accepts --status, --enable and --disable.',
		args: [{ name: 'action', description: 'status (default) | enable | disable' }],
		flags: [
			{ name: 'global', type: 'boolean', description: 'Apply to every project (~/.blocks/config.json)' },
			{ name: 'status', type: 'boolean', description: 'Same as "status"' },
			{ name: 'enable', type: 'boolean', description: 'Same as "enable"' },
			{ name: 'disable', type: 'boolean', description: 'Same as "disable"' },
		],
		examples: [
			{ command: 'blocks telemetry', description: 'Show the telemetry status' },
			{ command: 'blocks telemetry disable --global', description: 'Disable telemetry everywhere' },
		],
		handler: commands.telemetry,
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
			{ name: 'foundation', description: 'Backend entry (default: aws-blocks/index.ts)' },
			{ name: 'output', description: 'Output file (default: aws-blocks/client.js)' },
		],
		examples: [{ command: 'blocks generate client', description: 'Write aws-blocks/client.js' }],
		handler: commands.generateClient,
	},
	{
		path: ['generate', 'spec'],
		group: 'Generate',
		summary: 'Generate the OpenRPC spec',
		args: [
			{ name: 'backend', description: 'Backend entry (default: aws-blocks/index.ts)' },
			{ name: 'output', description: 'Output file (default: blocks.spec.json next to the backend)' },
		],
		examples: [{ command: 'blocks generate spec', description: 'Write aws-blocks/blocks.spec.json' }],
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
			{ command: 'blocks generate types', description: 'Regenerate the key types' },
			{ command: 'blocks generate types --check', description: 'Fail when they are stale' },
		],
		handler: commands.generateTypes,
	},
	// ── Data and blocks ──────────────────────────────────────────────────────
	{
		path: ['db'],
		group: 'Data and blocks',
		summary: 'Data block operations: migrate, status, generate-types, pull',
		description:
			'Run a data block operation. The verb and everything after it are forwarded unchanged\n' +
			'to the bb-data CLI of @aws-blocks/bb-data. "blocks db <verb> --help" shows its options.',
		args: [
			{ name: 'verb', description: 'migrate | status | generate-types | pull', required: true },
			{ name: 'args', description: 'Forwarded unchanged', variadic: true },
		],
		passthrough: true,
		verbs: ['migrate', 'status', 'generate-types', 'pull'],
		examples: [
			{ command: 'blocks db migrate', description: 'Apply pending migrations to the local database' },
			{ command: 'blocks db status', description: 'Show applied and pending migrations' },
			{ command: 'blocks db pull', description: 'Introspect the database and write its files' },
		],
		handler: commands.db,
	},
	// ── Project ──────────────────────────────────────────────────────────────
	{
		path: ['vendorize'],
		group: 'Project',
		summary: 'Copy a Building Block into the app for customization',
		args: [
			{ name: 'package', description: 'For example @aws-blocks/bb-kv-store', required: true },
			{ name: 'options', description: '--force overwrites an existing copy', variadic: true },
		],
		passthrough: true,
		examples: [{ command: 'blocks vendorize @aws-blocks/bb-kv-store', description: 'Copy KVStore into the app' }],
		handler: commands.vendorize,
	},
	{
		path: ['help'],
		group: 'Project',
		summary: 'Show help for a command',
		args: [{ name: 'command', description: 'For example "sandbox destroy"', variadic: true }],
		examples: [{ command: 'blocks help sandbox destroy', description: 'Help for "blocks sandbox destroy"' }],
		handler: commands.help,
	},
];

/** Hidden aliases. They keep the npm-script spellings working and never appear in grouped help. */
export const ALIASES: readonly AliasSpec[] = [
	{ name: ['dev:stop'], target: ['dev', 'stop'] },
	{ name: ['cleanup'], target: ['dev', 'stop'], args: ['--all'] },
	{ name: ['sandbox', 'up'], target: ['sandbox'] },
	{ name: ['sandbox:deploy'], target: ['sandbox', 'deploy'] },
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
