// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry for the commands whose work runs in this process.
 *
 * The lifecycle commands (`dev`, `sandbox`, `sandbox deploy`, `sandbox preview`,
 * `sandbox destroy`, `sandbox console`, `deploy`, `destroy`, `vendorize`) already
 * send their event from core, in their runner or in-process, so they are not
 * listed here: listing them would count every run twice.
 */

import type { trackExitCode as coreTrackExitCode } from '@aws-blocks/core/track-command';

type CommandName = Parameters<typeof coreTrackExitCode>[0];

/** Event name per command path (`path.join(' ')`), for the commands core does not track. */
export const CLI_TRACKED_COMMANDS: Readonly<Record<string, CommandName>> = {
	'dev stop': 'dev:stop',
	whoami: 'whoami',
	secret: 'secret',
	config: 'config',
	'generate client': 'generate:client',
	'generate spec': 'generate:spec',
	'generate types': 'generate:types',
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
export const loadCoreTelemetry: LoadTelemetry = () => import('@aws-blocks/core/track-command');

/**
 * Run `run` and send one telemetry event for it when `path` is a tracked command.
 *
 * Telemetry never changes the command's result. If core's `./track-command` entry
 * cannot be loaded (for example an installed `@aws-blocks/core` that predates it) or
 * the project root cannot be resolved, the command runs untracked. If the tracker
 * throws, before or after running the command, or returns another code, the
 * command's own exit code or error is what this returns.
 */
export async function withCommandTelemetry(
	path: readonly string[],
	findRoot: () => string | undefined,
	run: () => Promise<number>,
	load: LoadTelemetry,
): Promise<number> {
	const commandName = trackedCommandName(path);
	if (commandName === undefined) return run();

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
