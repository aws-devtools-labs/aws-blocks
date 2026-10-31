// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** The `blocks` CLI entry: parse, build the context, run the handler, map errors to exit codes. */

import { verbHelp } from './commands.js';
import { blocksVersion, type CliDeps, Context, processDeps } from './context.js';
import { CliError, ExitCode, formatError } from './errors.js';
import { commandHelp, rootHelp } from './help.js';
import { colorEnabled } from './output.js';
import { type ParsedInvocation, parseArgv } from './parse.js';

/**
 * Run the CLI with `argv` (without the node and script entries).
 *
 * @returns The process exit code: 0 success, 1 failure, 2 usage error, 130 interrupted.
 */
export async function main(argv: readonly string[], deps: CliDeps = processDeps()): Promise<number> {
	const report = (error: unknown) => {
		const debug = argv.includes('--debug');
		const verbose = debug || argv.includes('--verbose') || argv.includes('-v');
		deps.stderr.write(formatError(error, { debug, verbose, color: colorEnabled(deps.stderr, deps.env) }));
		return error instanceof CliError ? error.exitCode : ExitCode.Failure;
	};

	let parsed: ParsedInvocation;
	let ctx: Context;
	try {
		parsed = parseArgv(argv);
		ctx = new Context(parsed, deps);
	} catch (error) {
		return report(error);
	}

	const { command, globals } = parsed;
	// --version is a global flag: after a command it still only prints the version, and never runs the command.
	if (globals.version) {
		const version = blocksVersion();
		try {
			ctx.out.result({ version }, version);
		} catch (error) {
			return report(error);
		}
		return ExitCode.Ok;
	}
	if (!command) {
		ctx.out.text(rootHelp(blocksVersion()));
		return ExitCode.Ok;
	}
	if (globals.help) {
		if (parsed.helpVerb) {
			try {
				return await verbHelp(ctx, command, parsed.helpVerb);
			} catch (error) {
				return report(error);
			}
		}
		ctx.out.text(commandHelp(command));
		return ExitCode.Ok;
	}
	if (!command.handler) {
		// A command group without a subcommand: show what it contains, as a usage error.
		ctx.out.error(commandHelp(command));
		return ExitCode.Usage;
	}
	try {
		return await command.handler(ctx, {
			flags: parsed.flags,
			positionals: parsed.positionals,
			passthrough: parsed.passthrough,
		});
	} catch (error) {
		return report(error);
	}
}
