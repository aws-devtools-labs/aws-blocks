// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:net';

/** Number of consecutive ports probed when `attempts` is not given. */
const DEFAULT_ATTEMPTS = 20;
/** Loopback only: the dashboard never binds a routable interface. */
const DEFAULT_HOSTNAME = '127.0.0.1';

export interface PortScanOptions {
	/** First port to probe. */
	start: number;
	/** How many consecutive ports to probe, inclusive of `start`. Default 20. */
	attempts?: number;
	/** Interface to probe. Default '127.0.0.1'. */
	hostname?: string;
}

/**
 * Thrown when every port in the scanned range is occupied.
 *
 * Failing loudly is deliberate. Returning the original (busy) port instead
 * defers the failure to `server.listen`, where it surfaces as an unhandled
 * `EADDRINUSE` rejection with no hint about what to do next.
 */
export class NoFreePortError extends Error {
	readonly start: number;
	readonly attempts: number;

	constructor(start: number, attempts: number, hostname: string = DEFAULT_HOSTNAME) {
		super(
			`No free port in ${start}-${start + attempts - 1} on ${hostname} ` +
				`(probed ${attempts} port${attempts === 1 ? '' : 's'}). ` +
				'Free one of them, or choose a port explicitly with --port <n>.',
		);
		this.name = 'NoFreePortError';
		this.start = start;
		this.attempts = attempts;
	}
}

/**
 * Probes a single port by binding a throwaway server to it.
 *
 * Never rejects: an unbindable port (EADDRINUSE, EACCES, anything else) is
 * simply "not free". The probe socket is always closed before resolving, so
 * nothing is leaked whichever way the probe goes.
 */
export function isPortFree(port: number, hostname: string = DEFAULT_HOSTNAME): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		let settled = false;
		const settle = (free: boolean) => {
			if (settled) return;
			settled = true;
			resolve(free);
		};

		probe.once('error', () => {
			// The listen failed, so there is no bound handle to release. close()
			// is still called, with a callback purely so the "server was not
			// running" complaint lands there rather than as a second — and by
			// now unhandled — 'error' event.
			probe.close(() => {});
			settle(false);
		});
		probe.once('listening', () => {
			probe.close(() => settle(true));
		});
		probe.listen(port, hostname);
	});
}

/**
 * Returns the first free port in `start .. start+attempts-1` (inclusive).
 *
 * TOCTOU: the probe socket is closed before this resolves, so the port is only
 * known to have been free a moment ago — another process can claim it between
 * the probe and the real server's `listen`. The window is unavoidable without
 * handing the bound socket to the caller; the payoff is that the real server
 * binds the port normally. A loser in that race still fails loudly with
 * EADDRINUSE, which is the same outcome as an explicitly requested busy port.
 *
 * @throws NoFreePortError when every candidate in the range is occupied.
 */
export async function findFreePort(options: PortScanOptions): Promise<number> {
	const { start } = options;
	const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	const hostname = options.hostname ?? DEFAULT_HOSTNAME;

	for (let offset = 0; offset < attempts; offset++) {
		const candidate = start + offset;
		// Sequential on purpose: probing in parallel would bind every free port
		// in the range at once and report a port we then immediately release.
		if (await isPortFree(candidate, hostname)) return candidate;
	}

	throw new NoFreePortError(start, attempts, hostname);
}
