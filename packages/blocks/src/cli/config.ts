// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-app CLI configuration, read from `package.json` under `"blocks"`:
 *
 *     "blocks": { "dev": { "port": 3000, "frontendCommand": "npx vite --port 3100 --strictPort", "frontendPort": 3100 } }
 *
 * Without `blocks.dev.frontendCommand`, the frontend is detected from the app's
 * dependencies: `next` runs the Next.js dev server, `vite` runs Vite, and
 * neither runs the backend only. A detected dev server listens on
 * `frontendPort` (default 3100). Command-line flags override both.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, UsageError } from './errors.js';
import type { FlagValues } from './registry.js';

export interface DevConfig {
	/** Local server port. Default: 3000. */
	port?: number;
	/** Interface the local server binds. Default: 127.0.0.1. */
	host?: string;
	/** Command that starts the frontend dev server; absent detects it from the app's dependencies. */
	frontendCommand?: string;
	/** Port the frontend dev server listens on. Default: 3100. */
	frontendPort?: number;
}

export interface ResolvedDevConfig extends DevConfig {
	/** Where the frontend setting came from. */
	source: 'flags' | 'package.json' | 'vite' | 'next' | 'none';
}

interface AppPackageJson {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	blocks?: { dev?: Record<string, unknown> };
}

const DEFAULT_FRONTEND_PORT = 3100;

/** The frontend dev servers that auto-detection knows, by dependency name, in priority order. */
const FRONTENDS = [
	{ dependency: 'next', command: (port: number) => `npx next dev --webpack --hostname 127.0.0.1 --port ${port}` },
	{ dependency: 'vite', command: (port: number) => `npx vite --port ${port} --strictPort` },
] as const;

function readPackageJson(root: string): AppPackageJson {
	const path = join(root, 'package.json');
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as AppPackageJson;
	} catch (error) {
		throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parsePort(value: unknown, where: string): number | undefined {
	if (value === undefined) return undefined;
	const port = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new UsageError(`${where} must be a port number from 1 to 65535, not ${JSON.stringify(value)}.`);
	}
	return port;
}

function parseText(value: unknown, where: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.trim() === '') throw new UsageError(`${where} must be a non-empty string.`);
	return value;
}

/** Read `package.json#blocks.dev`, validated; `undefined` when absent. */
export function readDevConfig(root: string): DevConfig | undefined {
	const dev = readPackageJson(root).blocks?.dev;
	if (dev === undefined) return undefined;
	if (typeof dev !== 'object' || dev === null) throw new UsageError('package.json "blocks.dev" must be an object.');
	return {
		port: parsePort(dev.port, 'package.json "blocks.dev.port"'),
		host: parseText(dev.host, 'package.json "blocks.dev.host"'),
		frontendCommand: parseText(dev.frontendCommand, 'package.json "blocks.dev.frontendCommand"'),
		frontendPort: parsePort(dev.frontendPort, 'package.json "blocks.dev.frontendPort"'),
	};
}

/** The frontend that the app's dependencies imply, if any. */
export function detectFrontend(root: string): (typeof FRONTENDS)[number] | undefined {
	const pkg = readPackageJson(root);
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	return FRONTENDS.find((frontend) => frontend.dependency in deps);
}

/**
 * Resolve the dev server settings: flags, then `package.json#blocks.dev`, then
 * auto-detection of the frontend command, which listens on the resolved
 * `frontendPort`. `--no-frontend` drops the frontend from any source.
 */
export function resolveDevConfig(root: string, flags: FlagValues = {}): ResolvedDevConfig {
	if (
		flags['no-frontend'] === true &&
		(flags['frontend-command'] !== undefined || flags['frontend-port'] !== undefined)
	) {
		throw new UsageError('--no-frontend cannot be combined with --frontend-command or --frontend-port.');
	}
	const configured = readDevConfig(root);
	const resolved: ResolvedDevConfig = { ...configured, source: 'none' };
	const port = parsePort(flags.port, 'option --port');
	if (port !== undefined) resolved.port = port;
	const host = parseText(flags.host, 'option --host');
	if (host !== undefined) resolved.host = host;
	const frontendPort = parsePort(flags['frontend-port'], 'option --frontend-port');
	if (frontendPort !== undefined) resolved.frontendPort = frontendPort;
	const frontendCommand = parseText(flags['frontend-command'], 'option --frontend-command');
	if (flags['no-frontend'] === true) {
		resolved.frontendCommand = undefined;
		resolved.frontendPort = undefined;
		resolved.source = 'flags';
	} else if (frontendCommand !== undefined) {
		resolved.frontendCommand = frontendCommand;
		resolved.source = 'flags';
	} else if (resolved.frontendCommand !== undefined) {
		resolved.source = 'package.json';
	} else {
		const detected = detectFrontend(root);
		if (detected) {
			resolved.frontendPort ??= DEFAULT_FRONTEND_PORT;
			resolved.frontendCommand = detected.command(resolved.frontendPort);
			resolved.source = detected.dependency;
		}
	}
	return resolved;
}
