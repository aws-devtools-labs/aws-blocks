// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-app CLI configuration, read from `package.json` under `"blocks"`:
 *
 *     "blocks": { "dev": { "port": 3000, "frontendPort": 3100 } }
 *
 * Without `blocks.dev.frontendCommand`, the frontend is detected from the app's
 * dependencies: `next` runs the Next.js dev server, `vite` runs Vite, and
 * neither runs the backend only. A detected dev server listens on
 * `frontendPort` (default 3100). `"frontend": false` runs the backend only, as
 * `--no-frontend` does. Command-line flags override all of these.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, UsageError } from './errors.js';
import { suggest } from './parse.js';
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

/** `package.json#blocks.dev` as written: the dev server settings, and the backend-only switch. */
export interface DevPackageConfig extends DevConfig {
	/** `false` runs the backend only, with no frontend dev server. */
	frontend?: false;
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

/** Reads the app's package.json. A leading UTF-8 byte order mark is ignored, as npm ignores it. */
function readPackageJson(root: string): AppPackageJson {
	const path = join(root, 'package.json');
	try {
		return JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')) as AppPackageJson;
	} catch (error) {
		throw new CliError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** A port: an integer from 1 to 65535, written in decimal digits when it is a string (a flag value). */
function parsePort(value: unknown, where: string): number | undefined {
	if (value === undefined) return undefined;
	const port =
		typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
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

/** The `blocks.dev` keys that `blocks dev` reads, named in the unknown-key warning. */
const DEV_CONFIG_KEYS = ['port', 'host', 'frontendCommand', 'frontendPort', 'frontend'];
/** `blocks.dev` keys that core reads (the Amplify overlay's client-generation opt-out): accepted silently. */
const CORE_DEV_CONFIG_KEYS = ['generateClient'];

/** `package.json#blocks.dev` as written, checked to be an object; `undefined` when absent. */
function readRawDevConfig(root: string): Record<string, unknown> | undefined {
	const dev = readPackageJson(root).blocks?.dev;
	if (dev === undefined) return undefined;
	if (typeof dev !== 'object' || dev === null || Array.isArray(dev)) {
		throw new UsageError('package.json "blocks.dev" must be an object.');
	}
	return dev;
}

/**
 * Whether the app generates its own `aws-blocks/client.js` (`package.json#blocks.dev.generateClient: false`,
 * which the Amplify overlay writes): the generic client would replace it.
 */
export function keepsOwnClient(root: string): boolean {
	return readRawDevConfig(root)?.generateClient === false;
}

/** A warning for each `package.json#blocks.dev` key that nothing reads (a typo such as `prot`). */
export function unknownDevConfigWarnings(root: string): string[] {
	return Object.keys(readRawDevConfig(root) ?? {})
		.filter((key) => !DEV_CONFIG_KEYS.includes(key) && !CORE_DEV_CONFIG_KEYS.includes(key))
		.map((key) => {
			const nearest = suggest(key, DEV_CONFIG_KEYS);
			return (
				`package.json "blocks.dev.${key}" is not a dev setting, and is ignored.` +
				(nearest ? ` Did you mean "${nearest}"?` : ` The settings are ${DEV_CONFIG_KEYS.join(', ')}.`)
			);
		});
}

/**
 * The port of the app's dev server: `--port`, then `package.json#blocks.dev.port`, then 3000. Only the
 * port is read, so `blocks dev stop` works while another `blocks.dev` setting is invalid.
 */
export function resolveDevPort(root: string, flags: FlagValues = {}): number {
	return (
		parsePort(flags.port, 'option --port') ??
		parsePort(readRawDevConfig(root)?.port, 'package.json "blocks.dev.port"') ??
		3000
	);
}

/** Read `package.json#blocks.dev`, validated; `undefined` when absent. */
export function readDevConfig(root: string): DevPackageConfig | undefined {
	const dev = readRawDevConfig(root);
	if (dev === undefined) return undefined;
	const config: DevPackageConfig = {
		port: parsePort(dev.port, 'package.json "blocks.dev.port"'),
		host: parseText(dev.host, 'package.json "blocks.dev.host"'),
		frontendCommand: parseText(dev.frontendCommand, 'package.json "blocks.dev.frontendCommand"'),
		frontendPort: parsePort(dev.frontendPort, 'package.json "blocks.dev.frontendPort"'),
	};
	if (dev.frontend !== undefined && dev.frontend !== false) {
		throw new UsageError('package.json "blocks.dev.frontend" can only be false (backend only).');
	}
	if (dev.frontend === false) {
		if (config.frontendCommand !== undefined || config.frontendPort !== undefined) {
			throw new UsageError(
				'package.json "blocks.dev.frontend": false cannot be combined with "frontendCommand" or "frontendPort".',
			);
		}
		config.frontend = false;
	}
	return config;
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
 * `frontendPort`. `--no-frontend` drops the frontend from any source, and
 * `"frontend": false` drops the detected one; `--frontend-command` still overrides it.
 */
export function resolveDevConfig(root: string, flags: FlagValues = {}): ResolvedDevConfig {
	if (
		flags['no-frontend'] === true &&
		(flags['frontend-command'] !== undefined || flags['frontend-port'] !== undefined)
	) {
		throw new UsageError('--no-frontend cannot be combined with --frontend-command or --frontend-port.');
	}
	const { frontend, ...configured } = readDevConfig(root) ?? {};
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
	} else if (frontend === false) {
		resolved.frontendPort = undefined;
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

/**
 * A warning when a `frontendCommand` you set (flag or package.json) does not contain the frontend port
 * that the dev server proxies to: the command starts the frontend as written, so `--frontend-port`
 * does not move it, and the app answers 502 if it listens elsewhere.
 */
export function frontendPortWarning(config: ResolvedDevConfig): string | undefined {
	if (config.frontendCommand === undefined || (config.source !== 'flags' && config.source !== 'package.json')) {
		return undefined;
	}
	const port = config.frontendPort ?? DEFAULT_FRONTEND_PORT;
	if (new RegExp(`(^|\\D)${port}(\\D|$)`).test(config.frontendCommand)) return undefined;
	return (
		`the frontend command ${JSON.stringify(config.frontendCommand)} does not contain the frontend port ${port}, ` +
		'which the dev server proxies to; if the frontend listens on another port, the app answers 502. ' +
		'Put the port in the command, or drop "frontendCommand" so blocks dev detects next or vite and starts it on that port.'
	);
}
