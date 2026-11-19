// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry for the commands that have no core or bin entry point of their own.
 *
 * Every other command sends its event where its work runs, so an app that still
 * runs vendored `aws-blocks/scripts/*.ts` files (which call core directly) sends
 * it too: the lifecycle commands from core, `secret`, `config`, `generate spec`
 * and `generate types` from core's `runSecretCli`, `runConfigCli`, `writeSpec`
 * and `runTypegenCli`, and `generate client` from the `blocks-generate-client`
 * bin. They are not listed here: listing them would count every run twice.
 */

import type { trackExitCode as coreTrackExitCode } from '@aws-cdk-blocks/core/track-command';

export type CommandName = Parameters<typeof coreTrackExitCode>[0];

/** Event name per command path (`path.join(' ')`), for the commands only the CLI can track. */
export const CLI_TRACKED_COMMANDS: Readonly<Record<string, CommandName>> = {
	'dev stop': 'dev:stop',
	whoami: 'whoami',
	db: 'db',
	migrate: 'migrate',
	docs: 'docs',
	help: 'help',
};

/** The event name for a command path, or `undefined` when the CLI does not send one for it. */
export function trackedCommandName(path: readonly string[]): CommandName | undefined {
	return Object.hasOwn(CLI_TRACKED_COMMANDS, path.join(' ')) ? CLI_TRACKED_COMMANDS[path.join(' ')] : undefined;
}

type TrackExitCode = (
	commandName: CommandName,
	fn: () => Promise<number>,
	options?: { projectRoot?: string },
) => Promise<number>;

/** Loads core's `./track-command` entry (see `CliDeps.telemetry`). */
export type LoadTelemetry = () => Promise<{ trackExitCode: TrackExitCode }>;

/** The real loader. Imported lazily: commands with no event never load it. */
export const loadCoreTelemetry: LoadTelemetry = () => import('@aws-cdk-blocks/core/track-command');

/**
 * Run `run` and send one telemetry event for it when `path` is a command only the
 * CLI tracks (see {@link runTracked}).
 */
export function withCommandTelemetry(
	path: readonly string[],
	findRoot: () => string | undefined,
	run: () => Promise<number>,
	load: LoadTelemetry,
): Promise<number> {
	const commandName = trackedCommandName(path);
	if (commandName === undefined) return run();
	return runTracked(commandName, findRoot, run, load);
}

/**
 * Run `run` and send one `commandName` event for it.
 *
 * Telemetry never changes the command's result. If core's `./track-command` entry
 * cannot be loaded (for example an installed `@aws-cdk-blocks/core` that predates it) or
 * the project root cannot be resolved, the command runs untracked. If the tracker
 * throws, before or after running the command, or returns another code, the
 * command's own exit code or error is what this returns.
 */
export async function runTracked(
	commandName: CommandName,
	findRoot: () => string | undefined,
	run: () => Promise<number>,
	load: LoadTelemetry,
): Promise<number> {
	let trackExitCode: TrackExitCode;
	let projectRoot: string | undefined;
	try {
		({ trackExitCode } = await load());
		projectRoot = findRoot();
	} catch {
		return run();
	}

	// The command's own outcome, so that whatever the tracker does (throws before
	// or after running it, or returns another code) the result is the command's.
	let outcome: { code: number } | { error: unknown } | undefined;
	const tracked = async (): Promise<number> => {
		try {
			const code = await run();
			outcome = { code };
			return code;
		} catch (error) {
			outcome = { error };
			throw error;
		}
	};
	try {
		await trackExitCode(commandName, tracked, projectRoot === undefined ? undefined : { projectRoot });
	} catch {
		// Handled below from `outcome`: a command error is rethrown as it is.
	}
	if (outcome === undefined) return run(); // The tracker failed before it ran the command.
	if ('error' in outcome) throw outcome.error;
	return outcome.code;
}
