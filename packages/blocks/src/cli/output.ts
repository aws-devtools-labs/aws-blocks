// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Output of the `blocks` CLI: results on stdout; progress, warnings and errors
 * on stderr. With `--output json`, stdout carries exactly one JSON document.
 * Colour is used only on a TTY, never when `NO_COLOR` is set or `TERM=dumb`.
 */

/** The part of a stream that the CLI writes to. */
export interface OutputStream {
	write(chunk: string): unknown;
	isTTY?: boolean;
}

export type OutputFormat = 'text' | 'json';

/** True when colour codes may be written to `stream`. */
export function colorEnabled(stream: OutputStream, env: NodeJS.ProcessEnv): boolean {
	if (env.NO_COLOR) return false;
	if (env.TERM === 'dumb') return false;
	return stream.isTTY === true;
}

/**
 * The value at a dotted `path` in `value`, or `undefined` when a segment is
 * missing. Array elements are addressed by index: `stopped.0.port`.
 */
export function valueAtPath(value: unknown, path: string): unknown {
	let current = value;
	for (const segment of path.split('.')) {
		if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export class Output {
	readonly stderrColor: boolean;
	/** `json` with `--output json`, and with `--query`, so that child output stays off stdout. */
	readonly format: OutputFormat;

	constructor(
		private readonly stdout: OutputStream,
		private readonly stderr: OutputStream,
		format: OutputFormat,
		private readonly quiet: boolean,
		env: NodeJS.ProcessEnv,
		/** The `--query` path, checked against the result's shape before the command ran. */
		private readonly query?: string,
	) {
		this.stderrColor = colorEnabled(stderr, env);
		this.format = query ? 'json' : format;
	}

	/**
	 * Print a command result: with `--query`, the value at the path, raw (a string
	 * without quotes, `null` or an absent value such as a list element past the
	 * end as an empty line, an object as JSON); with `--output json`, `value` as
	 * one JSON document; otherwise `text`. Results print under `--quiet` too.
	 */
	result(value: unknown, text: string): void {
		if (this.query) {
			const selected = valueAtPath(value, this.query);
			const raw =
				selected === null || selected === undefined
					? ''
					: typeof selected === 'object'
						? JSON.stringify(selected, null, 2)
						: String(selected);
			this.stdout.write(`${raw}\n`);
		} else if (this.format === 'json') {
			this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		} else {
			this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
		}
	}

	/** Print help or other text that is the requested output. */
	text(text: string): void {
		this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
	}

	/** Progress on stderr; suppressed by `--quiet`. */
	progress(message: string): void {
		if (!this.quiet) this.stderr.write(`${message}\n`);
	}

	/** A warning on stderr; suppressed by `--quiet`. */
	warn(message: string): void {
		if (!this.quiet)
			this.stderr.write(`${this.stderrColor ? '\u001b[33mWarning:\u001b[39m' : 'Warning:'} ${message}\n`);
	}

	/** Raw text on stderr, always shown (errors, prompts). */
	error(text: string): void {
		this.stderr.write(text);
	}

	/** Bold text on stderr when colour is enabled. */
	bold(text: string): string {
		return this.stderrColor ? `\u001b[1m${text}\u001b[22m` : text;
	}
}
