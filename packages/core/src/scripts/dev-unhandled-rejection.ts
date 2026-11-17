// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local dev server only: survive an unhandled promise rejection that comes
 * from request handling, and log it clearly instead of exiting.
 *
 * The usual cause is a guard called without `await`
 * (`auth.requireRole(context, 'admin')`): the method returns its data before
 * the guard rejects, the rejection has no handler, and Node's default ends the
 * process. The dev server then stays down until the next file change. Here,
 * each request runs in an `AsyncLocalStorage` scope labelled with its method;
 * a rejection that carries a label is logged with that label, a hint and the
 * stack, and the server keeps serving. A rejection outside any request is
 * rethrown, so it ends the process exactly as Node's default would.
 *
 * Never installed by the Lambda handler: deployed behaviour is unchanged.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';

/** What the dev server knows about the request a rejection came from. */
export interface DevRequestScope {
	/** `namespace.method` for an RPC call, `METHOD /path` for a raw route. */
	readonly label: string;
	/** Whether the handler had already returned (its response went out without waiting). */
	returned: boolean;
}

const requests = new AsyncLocalStorage<DevRequestScope>();

/**
 * Run `fn` (one request's handler) in a scope labelled `label`, so a promise
 * it leaves unhandled can be traced back to it.
 */
export async function runDevRequest<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
	const scope: DevRequestScope = { label, returned: false };
	return requests.run(scope, async () => {
		try {
			return await fn();
		} finally {
			scope.returned = true;
		}
	});
}

function describeReason(reason: unknown): { headline: string; stack?: string } {
	if (reason instanceof Error) {
		return { headline: `${reason.name}: ${reason.message}`, ...(reason.stack ? { stack: reason.stack } : {}) };
	}
	if (typeof reason === 'string') return { headline: JSON.stringify(reason) };
	return { headline: inspect(reason, { depth: 2, breakLength: Infinity }) };
}

/** The log text for an unhandled rejection from the request `scope`. Pure. */
export function formatUnhandledRejection(reason: unknown, scope: DevRequestScope): string {
	const { headline, stack } = describeReason(reason);
	const lines = [
		`[unhandled-rejection] ${scope.label}: ${headline}`,
		scope.returned
			? '  The method had already returned, so its response was sent without waiting for this promise, and the error never reached the caller.'
			: '  Nothing handled this promise, so the error did not reach the caller.',
		'  Hint: is an `await` missing? A guard must be awaited to protect the method:',
		"  `await auth.requireAuth(context)` / `await auth.requireRole(context, 'admin')`.",
		'  The local dev server keeps running; on AWS Lambda an unhandled rejection fails the invocation.',
	];
	if (stack) {
		// The stack's first line repeats the headline.
		const frames = stack.split('\n').slice(1).join('\n');
		if (frames) lines.push(frames);
	}
	return lines.join('\n');
}

let installed = false;

/**
 * Install the dev server's `unhandledRejection` listener (idempotent). A
 * rejection from a request scope is logged through `log`; any other is
 * rethrown, which Node reports as an uncaught exception and exits on — the
 * same outcome as with no listener.
 */
export function installDevRejectionHandler(log: (text: string) => void = (text) => console.error(text)): void {
	if (installed) return;
	installed = true;
	process.on('unhandledRejection', (reason) => {
		const scope = requests.getStore();
		if (!scope) throw reason;
		log(formatUnhandledRejection(reason, scope));
	});
}
