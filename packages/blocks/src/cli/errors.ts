// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exit codes and the error format of the `cdk-blocks` CLI.
 *
 * Every failure prints on stderr in one shape:
 *
 *     Error: <what failed, one line>
 *       <where: command, stack, account/Region when relevant>
 *     Try: <next step, when known>
 *     Run with --verbose for the full tool output, or --debug for a stack trace.
 *
 * The last line names only what would add something: `--verbose` after a
 * lifecycle runner (core prints more at that level), `--debug` when there is a
 * stack trace to show.
 */

/**
 * How a printed `cdk-blocks` command runs in an app's shell, where the app's CLI is
 * not on PATH, as the app's AGENTS.md says: `--no` never downloads a package,
 * and `--` keeps npm from reading the command's options as its own.
 */
export const BLOCKS_COMMAND = 'npx --no -- cdk-blocks';

/** `cdk-blocks <words>` as a command to copy into the app's shell; see {@link BLOCKS_COMMAND}. */
export function blocksCommand(...words: string[]): string {
	return [BLOCKS_COMMAND, ...words].join(' ');
}

/** Process exit codes. */
export const ExitCode = {
	/** The command succeeded. */
	Ok: 0,
	/** The operation failed. */
	Failure: 1,
	/** Usage error: unknown command or flag, missing argument, or a confirmation that a non-interactive run cannot give. */
	Usage: 2,
	/** Interrupted with SIGINT. */
	Interrupted: 130,
	/** Stopped by a SIGTERM to the CLI, which the operation it ran ended on (`cdk-blocks sandbox deploy`, `cdk-blocks deploy`). */
	Terminated: 143,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface CliErrorDetails {
	/** Where it failed: the command, the stack, the account and Region. */
	where?: string[];
	/** The next step, for example `npx --no -- cdk-blocks destroy --yes` (see {@link blocksCommand}). */
	hint?: string;
	/** The exit code. Default: 1. */
	exitCode?: ExitCodeValue;
	/** The underlying error, printed with `--debug`. */
	cause?: unknown;
	/**
	 * A lifecycle runner failed: its output is core's, which `--verbose` extends,
	 * and it printed its own stack trace with `--debug`.
	 */
	runner?: boolean;
}

/** An error the CLI reports in its own format. */
export class CliError extends Error {
	readonly where: string[];
	readonly hint?: string;
	readonly exitCode: ExitCodeValue;
	readonly underlying?: unknown;
	readonly runner: boolean;

	constructor(message: string, details: CliErrorDetails = {}) {
		super(message);
		this.name = 'CliError';
		this.where = details.where ?? [];
		this.hint = details.hint;
		this.exitCode = details.exitCode ?? ExitCode.Failure;
		// Kept off `cause` so that a serialized error never carries it.
		this.underlying = details.cause;
		this.runner = details.runner === true;
	}
}

/** A usage error: exit code 2. */
export class UsageError extends CliError {
	constructor(message: string, details: Omit<CliErrorDetails, 'exitCode'> = {}) {
		super(message, { ...details, exitCode: ExitCode.Usage });
		this.name = 'UsageError';
	}
}

export interface FormatErrorOptions {
	debug: boolean;
	verbose: boolean;
	color: boolean;
}

/** Format an error for stderr. The result ends with a newline. */
export function formatError(error: unknown, options: FormatErrorOptions): string {
	const cli = error instanceof CliError ? error : undefined;
	const message = error instanceof Error ? error.message : String(error);
	const [first, ...rest] = message.split('\n');
	const label = options.color ? '\u001b[31mError:\u001b[39m' : 'Error:';
	const lines = [`${label} ${first}`, ...rest.map((line) => `  ${line.trimStart()}`)];
	for (const where of cli?.where ?? []) lines.push(`  ${where}`);
	if (cli?.hint) lines.push(`Try: ${cli.hint}`);
	const usage = cli?.exitCode === ExitCode.Usage;
	// The stack of what went wrong: the underlying error's, else the error's own,
	// except for a usage error (nothing broke) or a runner (it printed its own).
	const source = cli ? (cli.underlying ?? (usage || cli.runner ? undefined : cli)) : error;
	const stack = source instanceof Error ? source.stack : undefined;
	if (options.debug) {
		if (stack) lines.push(stack);
	} else if (cli?.runner) {
		lines.push(
			options.verbose
				? 'Run with --debug for a stack trace.'
				: 'Run with --verbose for the full tool output, or --debug for a stack trace.',
		);
	} else if (!usage && (!cli || cli.underlying instanceof Error)) {
		lines.push('Run with --debug for a stack trace.');
	}
	return `${lines.join('\n')}\n`;
}

/**
 * The CLI exit code for a child process result. A usage error (2) and an
 * interruption (130, or death by SIGINT) keep their meaning; any other
 * non-zero exit is an operation failure (1).
 */
export function exitCodeForChild(code: number | null, signal: NodeJS.Signals | null): ExitCodeValue {
	if (signal === 'SIGINT' || code === ExitCode.Interrupted) return ExitCode.Interrupted;
	if (code === 0) return ExitCode.Ok;
	if (code === ExitCode.Usage) return ExitCode.Usage;
	return ExitCode.Failure;
}
