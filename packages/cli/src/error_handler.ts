// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Maps a thrown error to a clean, user-facing message and a process exit code.
 * The bin (`blocks.ts`) wraps command execution in this handler so failures
 * print a single readable line instead of a raw stack trace.
 */

import { error as logError, isDebug } from './logger.js';

export interface HandledError {
	message: string;
	exitCode: number;
	stack?: string;
}

/** Normalize any thrown value into a message + exit code (+ stack when available). */
export function handleError(err: unknown): HandledError {
	if (err instanceof Error) {
		return { message: err.message, exitCode: 1, stack: err.stack };
	}
	return { message: String(err), exitCode: 1 };
}

/**
 * Print the handled error to stderr and set `process.exitCode`. Kept separate
 * from {@link handleError} so tests can assert the mapping without capturing
 * stderr or mutating the process. At `--debug` level the full stack trace is
 * printed as well, so a stack is one flag away rather than the default noise.
 */
export function reportError(err: unknown): void {
	const handled = handleError(err);
	logError(handled.message);
	if (isDebug() && handled.stack) {
		console.error(handled.stack);
	} else if (!isDebug()) {
		console.error('  Run again with --debug for the full stack trace.');
	}
	process.exitCode = handled.exitCode;
}
