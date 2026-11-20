#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * bb-database: the command line of the `Database` block for an existing PostgreSQL database
 * (`DatabaseCluster.fromExisting()`).
 *
 *   connect   Check the database, store its connection string, write the CA module
 *   migrate   Apply pending migration files to the development database, then refresh the types
 *   types     Write one `Tables` interface for Kysely from the live schema
 *   status    List the applied and the pending migration files
 *
 * The connection string is read from a hidden prompt or from stdin. It is never an argument and never printed.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Stage, StatusResult, TypesResult } from './cli/commands.js';
import { isUsageError, note, routeLogsToStderr, scrub, usageError } from './cli/io.js';
import type { BlockFlags } from './cli/owned.js';
import { DEFAULT_CONNECTION_NAME, DEFAULT_SCHEMA } from './constants.js';
import { causeChain } from './errors.js';

// The name in the usage text: `bb-database`, or the task that runs this file (`npm run db --`).
const COMMAND = process.env.BB_DATABASE_COMMAND || 'bb-database';
// A wrapper runs this file from the project root; explicit paths are relative to its starting directory.
const START_DIR = process.env.BB_DATABASE_START_DIR;
const fromCaller = (path: string | undefined): string | undefined =>
	path === undefined || !START_DIR ? path : resolve(START_DIR, path);

const HELP = `Usage: ${COMMAND} <command> [options]

Commands:
  connect [--name <name>] [--stage sandbox|production] [--ca <file>] [--value-stdin] [--check-only]
      Check an existing PostgreSQL database and store its connection string: for local mode by default,
      as the SSM SecureString /<stackName>-<name> with --stage. The string comes from a hidden prompt, or
      from stdin with --value-stdin. --ca <file> is the PEM file of the provider's certificate authority.
  migrate [dir] [--name <name>] [--schema <schema>] [--types <file> | --no-types]
      Apply the pending files of [dir] (default ./migrations) to the database of the local value, one
      transaction per file, then write the types file. Asks first; --yes skips the question.
  migrate [dir] --mark-applied <file> [--stage sandbox|production] [--name <name>] [--schema <schema>]
      Record <file> as applied without running it, for a file that describes what the database already
      has (a schema dump). With --stage, on the database of that stage. Repeat the option for more files.
  types [--name <name>] [--schema <schema>] [--out <file>]
      Write one Tables interface for Kysely (default cdk-blocks/database.types.ts).
  status [dir] [--name <name>] [--schema <schema>] [--stage sandbox|production]
      List the applied and the pending files of [dir].

For a block that provisions its cluster (no connection string), name the block:
  types [dir] --block <id> [--type dsql|aurora] [--cluster <id>] [--schema <schema>] [--out <file>]
      Write the Tables interface from the block's migration files (default cdk-blocks/migrations/<id>).
      --type aurora, or --cluster with the id of its DatabaseCluster, for a block that is not on its own
      Aurora DSQL cluster.
  status [dir] --block <id> [--cluster <id>] [--schema <schema>]
      List the applied and the pending files in the block's local database under .cdk-blocks/local/data/.

Options for every command:
  --output json|text   json prints one object on stdout and nothing else (default text)
  --no-input           never ask; fail with exit code 2 where a question would be needed
  --yes                answer yes to a question
  -h, --help           print this help

Exit codes: 0 success, 1 failure, 2 usage error.
`;

function stage(value: string | undefined): Stage | undefined {
	if (value === undefined) return undefined;
	if (value !== 'sandbox' && value !== 'production') throw usageError("--stage must be 'sandbox' or 'production'.");
	return value;
}

async function run(argv: string[]): Promise<{ json: unknown; text: string }> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (e) {
		throw usageError(e instanceof Error ? e.message : String(e));
	}
	const { values, positionals } = parsed;
	const command = positionals[0];
	const dir = fromCaller(positionals[1]);
	if (values.help || !command) return { json: { ok: true, help: HELP }, text: HELP };
	const common = {
		name: values.name ?? DEFAULT_CONNECTION_NAME,
		schema: values.schema ?? DEFAULT_SCHEMA,
		noInput: values['no-input'] ?? false,
		yes: values.yes ?? false,
	};
	const block = blockFlags(values, command, dir);
	if (!COMMANDS.includes(command)) throw usageError(`Unknown command '${command}'.\n\n${HELP}`);
	if (block) {
		// Loaded here: only these two commands need the local database engine.
		const { blockStatus, blockTypes } = await import('./cli/owned.js');
		return command === 'types'
			? typesOutput(await blockTypes({ ...block, out: fromCaller(values.out) }))
			: statusOutput(await blockStatus(block));
	}
	// Loaded after the checks above, so help and a usage error do not load the database driver.
	const { connect, linesToPaste, markApplied, migrate, status, types } = await import('./cli/commands.js');
	switch (command) {
		case 'connect': {
			const result = await connect({
				...common,
				stage: stage(values.stage),
				ca: fromCaller(values.ca),
				valueStdin: values['value-stdin'] ?? false,
				checkOnly: values['check-only'] ?? false,
			});
			const where =
				result.stored === 'ssm'
					? `Stored as the SSM SecureString ${result.parameterName}.`
					: result.stored === 'local'
						? 'Stored for local mode.'
						: 'Checked; nothing was stored.';
			const text = [
				`TLS verified (${result.tls.trust === 'ca' ? 'the certificate authority of --ca' : 'the system trust store'}).`,
				`PostgreSQL ${result.server.version}, role ${result.role.name}` +
					(result.role.canSetRole.length ? `, may switch to: ${result.role.canSetRole.join(', ')}` : '') +
					'.',
				...(result.pooler ? [`Supabase ${result.pooler.mode} endpoint.`] : []),
				...result.warnings.map((w) => `Warning: ${w}`),
				where,
				...(result.caModule
					? [
							values.ca
								? `Wrote ${result.caModule}.`
								: `Verified with the certificate authority in ${result.caModule}.`,
						]
					: []),
				...(result.stored === 'none' ? [] : ['', 'Add to your backend file:', linesToPaste(result)]),
			].join('\n');
			return { json: result, text };
		}
		case 'migrate': {
			const files = values['mark-applied'] ?? [];
			if (files.length > 0) {
				const result = await markApplied({ ...common, dir, files, stage: stage(values.stage) });
				const text = [
					...(result.marked.length
						? [`Recorded as applied on ${result.host}, not run: ${result.marked.join(', ')}`]
						: []),
					...(result.alreadyApplied.length ? [`Already recorded: ${result.alreadyApplied.join(', ')}`] : []),
				].join('\n');
				return { json: result, text };
			}
			if (values.stage !== undefined) {
				throw usageError(
					'migrate applies files to the development database only; the deploy migrates a stage. ' +
						'`status --stage` shows a stage, and `migrate --mark-applied <file> --stage` records a file there.',
				);
			}
			const result = await migrate({
				...common,
				dir,
				types: values['no-types'] ? false : (fromCaller(values.types) ?? ''),
			});
			const text =
				(result.applied.length
					? `Applied to ${result.host}: ${result.applied.join(', ')}`
					: 'No pending files.') + (result.types ? `\nWrote ${result.types}.` : '');
			return { json: result, text };
		}
		case 'types':
			return typesOutput(await types({ ...common, out: fromCaller(values.out) }));
		default:
			return statusOutput(await status({ ...common, dir, stage: stage(values.stage) }));
	}
}

const COMMANDS = ['connect', 'migrate', 'types', 'status'];

function typesOutput(result: TypesResult): { json: unknown; text: string } {
	return { json: result, text: `Wrote ${result.out} (${result.tables.length} table(s)).` };
}

function statusOutput(result: StatusResult): { json: unknown; text: string } {
	const text =
		`Applied: ${result.applied.length}   Pending: ${result.pending.length}` +
		result.pending.map((f) => `\n  ${f}`).join('') +
		(result.note ? `\n${result.note}` : '');
	return { json: result, text };
}

/** The flags of a block that provisions its cluster, when `--block` names one. */
function blockFlags(
	values: { block?: string; cluster?: string; type?: string; schema?: string; name?: string; stage?: string },
	command: string,
	dir: string | undefined,
): BlockFlags | undefined {
	if (values.block === undefined) {
		if (values.cluster !== undefined || values.type !== undefined) {
			throw usageError('--cluster and --type go with --block <id>.');
		}
		return undefined;
	}
	if (values.name !== undefined) {
		throw usageError(
			'--name is the connection of an existing database; --block is a block that provisions its cluster.',
		);
	}
	const type = values.type ?? 'dsql';
	if (type !== 'dsql' && type !== 'aurora') throw usageError("--type must be 'dsql' or 'aurora'.");
	if (command === 'connect' || command === 'migrate') {
		throw usageError(
			`${command} is for an existing database. A block that provisions its cluster applies its files itself: ` +
				'at its first statement locally, and during the deploy.',
		);
	}
	if (command === 'status' && values.stage !== undefined) {
		throw usageError('status --block reads the local database; it does not take --stage.');
	}
	return { block: values.block, cluster: values.cluster, type, schema: values.schema, dir };
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			output: { type: 'string' },
			'no-input': { type: 'boolean' },
			yes: { type: 'boolean', short: 'y' },
			help: { type: 'boolean', short: 'h' },
			name: { type: 'string' },
			schema: { type: 'string' },
			stage: { type: 'string' },
			ca: { type: 'string' },
			'value-stdin': { type: 'boolean' },
			'check-only': { type: 'boolean' },
			types: { type: 'string' },
			'no-types': { type: 'boolean' },
			'mark-applied': { type: 'string', multiple: true },
			block: { type: 'string' },
			cluster: { type: 'string' },
			type: { type: 'string' },
			out: { type: 'string' },
		},
	});
}

// The driver error under the block's fixed message says why a connection was refused (trust, address, login).
function reason(e: unknown): string {
	const parts: string[] = [];
	for (const err of causeChain(e)) {
		// The block's errors repeat their name at the start of the message; the name is reported separately.
		const message = err.message.startsWith(`${err.name}: `) ? err.message.slice(err.name.length + 2) : err.message;
		if (message && !parts.includes(message)) parts.push(message);
	}
	return parts.join(': ');
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const json = argv.some((a, i) => a === '--output=json' || (a === '--output' && argv[i + 1] === 'json'));
	routeLogsToStderr();
	try {
		const result = await run(argv);
		process.stdout.write(json ? `${JSON.stringify(result.json)}\n` : `${scrub(result.text)}\n`);
	} catch (e) {
		const usage = isUsageError(e);
		const error = { name: usage ? 'UsageError' : e instanceof Error ? e.name : 'Error', message: scrub(reason(e)) };
		if (json) process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
		else note(`${usage ? '' : `${error.name}: `}${error.message}`);
		process.exitCode = usage ? 2 : 1;
	}
}

await main();
