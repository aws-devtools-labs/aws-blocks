// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A mistake in how the command was called: exit code 2, and the message names the fix. Marked, not a class with
// its own name: these errors never leave the command line, so they are not CDK Blocks errors.
const usageErrors = new WeakSet<Error>();

export function usageError(message: string): Error {
	const error = new Error(message);
	usageErrors.add(error);
	return error;
}

export const isUsageError = (e: unknown): boolean => e instanceof Error && usageErrors.has(e);

// Every secret the process has read. Nothing the CLI prints may contain one, whatever a driver or a parser put
// into an error message.
const secrets: string[] = [];

export function remember(...values: (string | undefined)[]): void {
	for (const value of values) if (value && value.length >= 4 && !secrets.includes(value)) secrets.push(value);
}

export function scrub(text: string): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join('****');
	return out;
}

/** Progress, warnings and library logs: always stderr, so `--output json` leaves stdout to the one result object. */
export function note(message: string): void {
	process.stderr.write(`${scrub(message)}\n`);
}

/** Send everything a dependency logs to stderr, scrubbed. `console.log` and `console.debug` write to stdout by default. */
export function routeLogsToStderr(): void {
	const write = (...args: unknown[]): void =>
		note(args.map((a) => (typeof a === 'string' ? a : safeInspect(a))).join(' '));
	console.log = write;
	console.info = write;
	console.debug = () => {};
	console.warn = write;
	console.error = write;
}

function safeInspect(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString('utf8').trim();
}

/** Read one line from the terminal without echo. Ctrl-C ends the process with 130, as a shell expects. */
export function readHidden(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) throw usageError('There is no terminal to ask on. Pass the value on stdin with --value-stdin.');
	process.stderr.write(prompt);
	return new Promise((resolve, reject) => {
		let value = '';
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');
		const done = (fn: () => void): void => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener('data', onData);
			process.stderr.write('\n');
			fn();
		};
		const onData = (chunk: string): void => {
			for (const char of chunk) {
				if (char === '\u0003') {
					done(() => process.exit(130));
					return;
				}
				if (char === '\u0004' && value === '') {
					done(() => reject(usageError('No value was entered.')));
					return;
				}
				if (char === '\r' || char === '\n') {
					done(() => resolve(value.trim()));
					return;
				}
				if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
				else if (char >= ' ') value += char;
			}
		};
		stdin.on('data', onData);
	});
}

export async function confirm(question: string): Promise<boolean> {
	if (!process.stdin.isTTY)
		throw usageError('There is no terminal to ask on. Pass --yes to run without the question.');
	process.stderr.write(`${question} (y/N) `);
	const answer = await new Promise<string>((resolve) => {
		process.stdin.resume();
		process.stdin.setEncoding('utf8');
		process.stdin.once('data', (d) => {
			process.stdin.pause();
			resolve(String(d).trim());
		});
	});
	return /^y(es)?$/i.test(answer);
}
