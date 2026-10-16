// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Environment detection probes for the doctor report.
 *
 * PROBES ONLY — nothing here decides whether what it found is good or bad.
 * Every function returns plain data and the judgement lives in doctor.ts's pure
 * `buildDoctorChecks`, which is what makes the report testable without a
 * filesystem or a network.
 *
 * Two rules hold for every probe in this file:
 *
 * 1. It never throws. Doctor exists to describe a broken environment, so a
 *    probe that rejects would take down the very report meant to explain the
 *    breakage.
 * 2. It says HOW it knows. A discovered port and a fallback port are different
 *    facts even when the number is identical, so `resolveLocalPort` reports its
 *    source rather than letting the caller mistake 3000-by-default for
 *    3000-configured.
 */

/** Port the Blocks dev server uses when `server.ts` names none. */
export const DEFAULT_LOCAL_PORT = 3000;

/** Probes must not hang the report; the dev server is on loopback or nowhere. */
export const PROBE_TIMEOUT_MS = 1500;

export interface LocalDevServerStatus {
	/** The dev server answered the RPC probe. */
	serverUp: boolean;
	/** Base URL probed, so the report can name what it tried. */
	serverUrl: string;
	port: number;
	/** Whether `port` was discovered or is just the default. */
	portSource: 'server-script' | 'default';
	/** API namespaces the running server reported, `[]` when unknown. */
	namespaces: string[];
	/** `.bb-data` exists — local data has been generated at least once. */
	bbDataPresent: boolean;
}

/** `startDevServer({ port: 4000 })` in the app's server script. */
const PORT_PATTERN = /port:\s*(\d+)/;

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * The port the local dev server would listen on.
 *
 * `source` is the point of the return shape: a parse that found nothing and a
 * `server.ts` that really says 3000 are indistinguishable from the number
 * alone, and a report that cannot tell them apart sends people to look at the
 * wrong thing.
 */
export function resolveLocalPort(projectRoot: string): { port: number; source: 'server-script' | 'default' } {
	try {
		const script = readFileSync(join(projectRoot, 'aws-blocks', 'scripts', 'server.ts'), 'utf-8');
		const match = PORT_PATTERN.exec(script);
		if (match) {
			const port = Number.parseInt(match[1], 10);
			if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) {
				return { port, source: 'server-script' };
			}
		}
	} catch {
		// No server.ts, or unreadable — the default is the honest answer.
	}
	return { port: DEFAULT_LOCAL_PORT, source: 'default' };
}

/** Base URL of the local Blocks dev server. */
export function localBlocksUrl(projectRoot: string): string {
	return `http://localhost:${resolveLocalPort(projectRoot).port}`;
}

/** `API 'x' not found. Available: api, admin` */
const AVAILABLE_PATTERN = /Available:\s*([^\n]*)/;

/**
 * Mines the live API namespace list out of the dev server's method-not-found
 * message.
 *
 * This deliberately depends on an UPSTREAM ERROR-MESSAGE FORMAT (dev-server.ts's
 * `methodNotFoundResponse`), which is not a contract. When that wording changes
 * this degrades to `[]` — "we could not tell" — rather than failing the probe:
 * the namespace list is a nicety, server-up/server-down is the fact that matters.
 */
export function parseNamespacesFromRpcError(message: string): string[] {
	const match = AVAILABLE_PATTERN.exec(message);
	if (!match) return [];
	return match[1]
		.split(',')
		.map((namespace) => namespace.trim().replace(/['".]+$/, ''))
		.filter((namespace) => namespace.length > 0);
}

/**
 * CloudFormation stack names this project could plausibly have deployed,
 * mirroring core's naming scheme: production is `<stackId>-prod` and a sandbox
 * is `<stackId>-<sandboxId>`.
 *
 * These are CANDIDATES, not findings — whether any of them exists is a separate
 * question that needs AWS. Order is part of the contract: index 0 is always
 * production, index 1 (when present) is the sandbox.
 *
 * Every read AND every parse is guarded. A malformed package.json is a
 * perfectly ordinary state of a project someone is mid-edit on, and letting it
 * throw here would replace the entire cloud section of the report with a
 * rejection — the report would fail to describe exactly the broken workspace it
 * exists for.
 */
export function stackNameCandidates(projectRoot: string): string[] {
	const stackId = readStackId(projectRoot);
	if (!stackId) return [];
	const candidates = [`${stackId}-prod`];
	const sandboxId = readSandboxId(projectRoot);
	if (sandboxId) candidates.push(`${stackId}-${sandboxId}`);
	return candidates;
}

/** Deployed stack id, else the package name. Never throws. */
function readStackId(projectRoot: string): string | undefined {
	return (
		readJsonString(join(projectRoot, '.blocks', 'config.json'), 'stackId') ??
		readJsonString(join(projectRoot, 'package.json'), 'name')
	);
}

/** Read (never create) the sandbox id. Never throws. */
function readSandboxId(projectRoot: string): string | undefined {
	try {
		const id = readFileSync(join(projectRoot, '.blocks-sandbox', 'sandbox-id.txt'), 'utf-8').trim();
		return id === '' ? undefined : id;
	} catch {
		return undefined;
	}
}

/** One non-empty string field out of a JSON file. Read and parse both guarded. */
function readJsonString(path: string, field: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8'));
		const value = parsed?.[field];
		return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** The probe RPC: a namespace that cannot exist, so the server names the real ones. */
const PROBE_RPC_BODY = JSON.stringify({
	jsonrpc: '2.0',
	method: '__blocksDashboardProbe__.__probe__',
	params: [],
	id: 1,
});

/**
 * Probes the local Blocks dev server.
 *
 * @param fetchImpl - Test seam. Tests must never reach a real socket, not even
 *                    loopback: a developer with something else on port 3000
 *                    would otherwise see this suite flake.
 */
export async function detectLocalDevServer(
	projectRoot: string,
	fetchImpl: typeof fetch = fetch,
): Promise<LocalDevServerStatus> {
	const { port, source } = resolveLocalPort(projectRoot);
	const serverUrl = `http://localhost:${port}`;
	// Independent of the server: data can be generated and the server stopped.
	const bbDataPresent = existsSync(join(projectRoot, '.bb-data'));

	let serverUp = false;
	let namespaces: string[] = [];
	try {
		const response = await fetchImpl(`${serverUrl}/aws-blocks/api`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: PROBE_RPC_BODY,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		serverUp = response.ok;
		if (serverUp) namespaces = await mineNamespaces(response);
	} catch {
		// Connection refused, DNS, abort/timeout — all mean "not running".
		// Never propagated: a stopped dev server is a normal state to REPORT.
		serverUp = false;
		namespaces = [];
	}

	return { serverUp, serverUrl, port, portSource: source, namespaces, bbDataPresent };
}

/** Namespaces out of the JSON-RPC error body; `[]` if the body is not what we expect. */
async function mineNamespaces(response: Response): Promise<string[]> {
	try {
		const body = (await response.json()) as { error?: { message?: string } };
		return parseNamespacesFromRpcError(body?.error?.message ?? '');
	} catch {
		return [];
	}
}
