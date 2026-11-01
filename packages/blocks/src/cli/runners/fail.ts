// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** How a lifecycle runner reports an error that ends it. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { log } from '@aws-blocks/core/scripts';
import { DEV_FAILURE_FILE_ENV, DEV_STATE } from './launch.js';

/** The dev server session that {@link trackDevSession} records for `blocks dev`. */
let devSession: { file: string; firstRun: boolean; starting: boolean } | undefined;

function readState(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf-8');
	} catch {
		return undefined;
	}
}

function writeState(file: string, state: string): void {
	try {
		writeFileSync(file, state);
	} catch {
		// Best effort: without the file, `blocks dev` reports the exit code of `tsx watch`.
	}
}

/**
 * End the `blocks dev` session on a failure of the first dev server start: record
 * `reason` for the CLI, and SIGTERM the `tsx watch` parent, which would otherwise
 * wait for a file change forever, or exit 0 when it watches nothing (the runner is
 * in node_modules, which it ignores). A failure after a start, or of a reload, leaves
 * `tsx watch` waiting for the fix, as it always has.
 */
function failDevSession(reason: string): void {
	const session = devSession;
	if (!session?.firstRun || !session.starting || readState(session.file) !== DEV_STATE.running) return;
	writeState(session.file, reason);
	if (process.ppid > 1) {
		try {
			process.kill(process.ppid, 'SIGTERM');
		} catch {
			// The watcher has gone.
		}
	}
}

/** The exit codes of a stop by SIGHUP, SIGINT or SIGTERM: tsx's preflight exits 128 + the signal number on one that nothing handles yet. */
const STOP_EXIT_CODES = new Set([129, 130, 143]);

/**
 * For the dev server runner of `blocks dev` (when `BLOCKS_DEV_FAILURE_FILE` is set):
 * record the runner's state in that file (see `DEV_STATE`), so that `blocks dev`
 * tells a failed start from a requested stop, whatever `tsx watch` exits with.
 * A failing exit before {@link started} on the first start ends the session.
 */
export function trackDevSession(): { started(): void } {
	const file = process.env[DEV_FAILURE_FILE_ENV];
	if (!file) return { started: () => {} };
	const session = { file, firstRun: !existsSync(file), starting: true };
	devSession = session;
	writeState(file, DEV_STATE.running);
	process.once('exit', (code) => {
		if (code !== 0 && !STOP_EXIT_CODES.has(code)) failDevSession(`the dev server exited with code ${code} while starting`);
		// A reason that this runner or core recorded stays for the CLI.
		if (readState(file) === DEV_STATE.running) writeState(file, DEV_STATE.stopped);
	});
	return {
		started: () => {
			session.starting = false;
		},
	};
}

/**
 * Print the error's message and exit 1. The stack trace prints only at
 * `BLOCKS_LOG_LEVEL=debug` (`--debug`), as the CLI's own errors do: core has
 * usually printed its guidance for the failure already.
 *
 * A failed first start of the dev server ends `blocks dev` (see {@link trackDevSession}).
 */
export function exitWithError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`❌ ${message}`);
	log.debugError(error);
	failDevSession(message);
	process.exit(1);
}
