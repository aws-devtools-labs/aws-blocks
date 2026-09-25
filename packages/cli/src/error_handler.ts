// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Maps a thrown error to a clean, user-facing message and a process exit code.
 * The bin (`blocks.ts`) wraps command execution in this handler so failures
 * print a single readable line instead of a raw stack trace.
 */

export interface HandledError {
	message: string;
	exitCode: number;
}

/** Normalize any thrown value into a message + exit code. */
export function handleError(error: unknown): HandledError {
	if (error instanceof Error) {
		return { message: error.message, exitCode: 1 };
	}
	return { message: String(error), exitCode: 1 };
}

/**
 * Print the handled error to stderr and set `process.exitCode`. Kept separate
 * from {@link handleError} so tests can assert the mapping without capturing
 * stderr or mutating the process.
 */
export function reportError(error: unknown): void {
	const handled = handleError(error);
	console.error(`✖ ${handled.message}`);
	process.exitCode = handled.exitCode;
}
