// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { trackCommand } from '../telemetry/trackCommand.js';
import { openInBrowser } from './console.js';
import { findFreePort } from './port-scan.js';
import { resolveProject } from './project-discovery.js';

export const DEFAULT_DASHBOARD_PORT = 4400;

const ADMIN_UI_PACKAGE = '@aws-blocks/admin-ui';
const ADMIN_UI_SERVER_ENTRY = `${ADMIN_UI_PACKAGE}/server`;
const ADMIN_UI_DOCTOR_ENTRY = `${ADMIN_UI_PACKAGE}/doctor`;

/** Subcommands of `blocks dashboard`. `serve` is the default. */
export type DashboardCommand = 'serve' | 'doctor';

export interface DashboardOptions {
	/**
	 * Root of the Blocks app (where package.json and .blocks/ live). When
	 * omitted the project is discovered from the working directory (or from
	 * `--project`). An explicit value here wins over both and is used verbatim.
	 */
	projectRoot?: string;
	/** Port to serve on. Overrides --port. Default: first free port from 4400. */
	port?: number;
	/** Open the browser after start. Overrides --no-open. Default true. */
	open?: boolean;
	/** AWS profile to read the environment with. Overrides --profile. */
	profile?: string;
	/** AWS region to read the environment in. Overrides --region. */
	region?: string;
	/** Browser origins to trust for mutating requests. Overrides --allow-origin. */
	allowOrigins?: string[];
	/** CLI args to parse. Default process.argv.slice(2). */
	argv?: string[];
}

export interface DashboardArgs {
	command: DashboardCommand;
	port?: number;
	open: boolean;
	profile?: string;
	region?: string;
	project?: string;
	allowOrigins?: string[];
	json: boolean;
}

/**
 * Parses the `blocks dashboard` argument list.
 *
 * Accepts an optional leading positional subcommand (`serve` | `doctor`)
 * followed by `--port <n>`/`--port=<n>`, `--no-open`, `--json`, and
 * `--profile`/`--region`/`--project`/`--allow-origin` in either `--flag value`
 * or `--flag=value` form. `--allow-origin` may be repeated, since a dashboard
 * can legitimately be reached through more than one proxy. Unrecognised flags
 * are ignored, as before.
 */
export function parseDashboardArgs(argv: string[]): DashboardArgs {
	const args: DashboardArgs = { command: 'serve', open: true, json: false };

	// Only position 0 may be a subcommand; anything later is a flag or its value.
	let index = 0;
	const first = argv[0];
	if (first !== undefined && !first.startsWith('-')) {
		args.command = parseCommand(first);
		index = 1;
	}

	for (let i = index; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--no-open') {
			args.open = false;
		} else if (arg === '--json') {
			args.json = true;
		} else if (arg === '--port') {
			args.port = parsePort(argv[++i]);
		} else if (arg.startsWith('--port=')) {
			args.port = parsePort(arg.slice('--port='.length));
		} else if (arg === '--profile') {
			args.profile = parseValueFlag('--profile', argv[++i]);
		} else if (arg.startsWith('--profile=')) {
			args.profile = parseValueFlag('--profile', arg.slice('--profile='.length));
		} else if (arg === '--region') {
			args.region = parseValueFlag('--region', argv[++i]);
		} else if (arg.startsWith('--region=')) {
			args.region = parseValueFlag('--region', arg.slice('--region='.length));
		} else if (arg === '--project') {
			args.project = parseValueFlag('--project', argv[++i]);
		} else if (arg.startsWith('--project=')) {
			args.project = parseValueFlag('--project', arg.slice('--project='.length));
		} else if (arg === '--allow-origin') {
			args.allowOrigins = [...(args.allowOrigins ?? []), parseValueFlag('--allow-origin', argv[++i])];
		} else if (arg.startsWith('--allow-origin=')) {
			args.allowOrigins = [
				...(args.allowOrigins ?? []),
				parseValueFlag('--allow-origin', arg.slice('--allow-origin='.length)),
			];
		}
	}

	return args;
}

function parseCommand(value: string): DashboardCommand {
	if (value === 'serve' || value === 'doctor') return value;
	throw new Error(`Unknown dashboard command: ${value}. Expected "serve" or "doctor".`);
}

function parsePort(value: string | undefined): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid --port value: ${value ?? '(missing)'}`);
	}
	return port;
}

/**
 * Reads the value of a string-valued flag. A missing value, or one that looks
 * like the next flag, is a typo rather than an empty value — `--profile --json`
 * must not silently set the profile to `--json`.
 */
function parseValueFlag(flag: string, value: string | undefined): string {
	if (value === undefined || value === '' || value.startsWith('-')) {
		throw new Error(`Missing value for ${flag}. Expected ${flag} <value>.`);
	}
	return value;
}

/** Builds the URL handed to the browser: token travels in the fragment only. */
export function buildDashboardUrl(baseUrl: string, token: string): string {
	return `${baseUrl}/#token=${token}`;
}

/**
 * The redirect document that carries the token URL to the browser.
 *
 * Exported for the test: the URL sits in an HTML attribute, so a quote or an
 * ampersand in it must not be able to break out of that attribute.
 */
export function buildRedirectDocument(url: string): string {
	const escaped = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
	return `<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}">\n`;
}

/**
 * Opens the dashboard without putting the session token on a command line.
 *
 * {@link openInBrowser} hands its argument to `xdg-open`/`open`/`start` as an
 * argv element, and that opener hands it to the browser it launches. On a shared
 * host any other user can then read the token out of `ps` or
 * `/proc/<pid>/cmdline` and replay it against the loopback API, which holds this
 * developer's AWS credentials and permits cloud writes once unlocked. The token
 * is the layer meant to stop exactly that, and the URL fragment keeps it off the
 * wire but not out of argv.
 *
 * So the token travels in a redirect document inside a `mkdtemp` directory,
 * which is created 0700, and the opener only ever sees that file's path. The
 * browser runs as this same user, so it can read the document; nobody else can.
 *
 * The fallback is NOT to pass the token on the command line after all: the URL
 * is printed to this terminal anyway, so a failure here asks the developer to
 * open it instead. For a shared host where even that is unwanted, `--no-open`
 * starts the server and prints the URL without launching anything.
 */
function openDashboardUrl(url: string): void {
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), 'blocks-dashboard-'));
		const redirect = join(dir, 'open.html');
		writeFileSync(redirect, buildRedirectDocument(url), { mode: 0o600 });
		openInBrowser(pathToFileURL(redirect).href);
		// The browser reads the document as it navigates; keeping it on disk only
		// widens the window, so drop it once a cold browser start has had time.
		const sweep = setTimeout(() => rmSync(dir as string, { recursive: true, force: true }), 60_000);
		sweep.unref();
	} catch {
		if (dir) rmSync(dir, { recursive: true, force: true });
		console.log('(Could not hand the URL to a browser safely — open the URL above manually.)');
	}
}

interface AdminUiServerModule {
	startDashboardServer(options: {
		projectRoot: string;
		token: string;
		port?: number;
		profile?: string;
		region?: string;
		allowedOrigins?: string[];
	}): Promise<{ url: string; port: number; close(): Promise<void> }>;
}

type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

interface DoctorCheck {
	id: string;
	label: string;
	status: DoctorCheckStatus;
	detail: string;
	remediation?: string;
}

interface DoctorReport {
	projectRoot: string;
	projectName: string;
	projectVia: string;
	checks: DoctorCheck[];
	awsContext?: unknown;
}

interface AdminUiDoctorModule {
	runDoctor(options: { projectRoot: string; profile?: string; region?: string }): Promise<DoctorReport>;
}

/**
 * Resolves @aws-blocks/admin-ui from the app. The dashboard is opt-in: the
 * package is NOT a dependency of core. If it isn't installed we offer a
 * one-time `npm install --save-dev` (interactive terminals only).
 */
export async function resolveAdminUi(projectRoot: string): Promise<AdminUiServerModule> {
	return await resolveAdminUiEntry<AdminUiServerModule>(projectRoot, ADMIN_UI_SERVER_ENTRY);
}

/** Same resolve-and-offer-install flow, for the doctor entry point. */
async function resolveAdminUiDoctor(projectRoot: string): Promise<AdminUiDoctorModule> {
	return await resolveAdminUiEntry<AdminUiDoctorModule>(projectRoot, ADMIN_UI_DOCTOR_ENTRY);
}

/**
 * Resolves one admin-ui subpath export from the app, installing the package
 * first if it is missing. Shared by the server and doctor entry points so
 * both offer the same one-time install.
 */
async function resolveAdminUiEntry<T>(projectRoot: string, specifier: string): Promise<T> {
	const entry = tryResolve(projectRoot, specifier) ?? (await installAdminUi(projectRoot, specifier));
	return (await import(pathToFileURL(entry).href)) as T;
}

function tryResolve(projectRoot: string, specifier: string): string | undefined {
	const require = createRequire(join(projectRoot, 'package.json'));
	try {
		return require.resolve(specifier);
	} catch {
		return undefined;
	}
}

async function installAdminUi(projectRoot: string, specifier: string): Promise<string> {
	const manualHint = `Install it manually with: npm install --save-dev ${ADMIN_UI_PACKAGE}`;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error(`The Blocks dashboard requires ${ADMIN_UI_PACKAGE}, which is not installed. ${manualHint}`);
	}

	console.log(`The Blocks dashboard is served by ${ADMIN_UI_PACKAGE}, which is not installed yet.`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question('Install it now as a dev dependency? (one-time) [Y/n] ')).trim().toLowerCase();
	rl.close();
	if (answer === 'n' || answer === 'no') {
		throw new Error(`Dashboard start aborted. ${manualHint}`);
	}

	const result = spawnSync('npm', ['install', '--save-dev', ADMIN_UI_PACKAGE], {
		cwd: projectRoot,
		stdio: 'inherit',
	});
	if (result.status !== 0) {
		throw new Error(`npm install failed. ${manualHint}`);
	}

	const entry = tryResolve(projectRoot, specifier);
	if (!entry) {
		throw new Error(`${ADMIN_UI_PACKAGE} was installed but could not be resolved. ${manualHint}`);
	}
	return entry;
}

/**
 * Decides which Blocks app the command acts on.
 *
 * An explicit `options.projectRoot` is a programmatic caller (the template's
 * own `scripts/dashboard.ts` wrapper knows exactly where it lives), so it is
 * honoured verbatim and never second-guessed. Everything else goes through
 * discovery, seeded with `--project` when the user named one.
 */
function resolveProjectRoot(options: DashboardOptions, args: DashboardArgs): string {
	if (options.projectRoot !== undefined) return options.projectRoot;

	const resolution = resolveProject({ startDir: process.cwd(), explicitPath: args.project });
	if (!resolution.ok) {
		const lines = [resolution.message];
		// An ambiguous result is only actionable if we name what we found.
		if (resolution.reason === 'ambiguous') lines.push(...resolution.candidates);
		throw new Error(lines.join('\n'));
	}

	if (resolution.shadowed.length > 0) {
		console.warn(
			`Using the Blocks project at ${resolution.project.path}; ` +
				`passed over ${resolution.shadowed.length} other Blocks project(s):`,
		);
		for (const other of resolution.shadowed) console.warn(`  ${other}`);
	}
	return resolution.project.path;
}

const DOCTOR_MARKS: Record<DoctorCheckStatus, string> = {
	ok: 'ok',
	warn: '!!',
	fail: 'XX',
	skipped: '--',
};

/** Renders a report as aligned `<mark> <label> — <detail>` lines. */
function formatDoctorReport(report: DoctorReport): string {
	const lines = [`Blocks doctor — ${report.projectName} (${report.projectRoot}, via ${report.projectVia})`];
	const width = report.checks.reduce((max, check) => Math.max(max, check.label.length), 0);
	for (const check of report.checks) {
		lines.push(`${DOCTOR_MARKS[check.status]} ${check.label.padEnd(width)} — ${check.detail}`);
		if (check.remediation) lines.push(`     ${check.remediation}`);
	}
	return lines.join('\n');
}

/**
 * `blocks dashboard doctor`: diagnoses the app and prints the report. Starts
 * no server, changes nothing, and always resolves — a failing check is data,
 * not an exception.
 */
async function runDoctorCommand(projectRoot: string, options: DashboardOptions, args: DashboardArgs): Promise<void> {
	const doctorModule = await resolveAdminUiDoctor(projectRoot);
	const report = await doctorModule.runDoctor({
		projectRoot,
		profile: options.profile ?? args.profile,
		region: options.region ?? args.region,
	});

	// --json output is machine-readable: the report and nothing else.
	console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
}

/**
 * `blocks dashboard`: boots the Admin UI for the app at projectRoot.
 *
 * The server binds to 127.0.0.1 only and every /api request must present the
 * crypto-random per-process session token, which reaches the browser via the
 * URL fragment (never sent to the server, never persisted).
 *
 * Telemetry (the WAU retention metric, §1 of the design doc): the
 * 'dashboard' event is sent as soon as the server is up — NOT at process
 * exit, since dashboard sessions end with Ctrl+C/kill and an exit-time
 * event would undercount usage to near zero. trackCommand wraps only the
 * boot phase; the signal wait lives outside it.
 */
export async function dashboard(options: DashboardOptions = {}) {
	let server: { url: string; close(): Promise<void> } | undefined;

	await trackCommand('dashboard', async () => {
		const args = parseDashboardArgs(options.argv ?? process.argv.slice(2));
		const projectRoot = resolveProjectRoot(options, args);

		if (args.command === 'doctor') {
			await runDoctorCommand(projectRoot, options, args);
			return;
		}

		// An explicitly requested port is used verbatim and never scanned past:
		// if it is busy the user needs to hear EADDRINUSE, not get a neighbour.
		const explicitPort = options.port ?? args.port;
		const port = explicitPort ?? (await findFreePort({ start: DEFAULT_DASHBOARD_PORT }));
		if (explicitPort === undefined && port !== DEFAULT_DASHBOARD_PORT) {
			console.log(`Port ${DEFAULT_DASHBOARD_PORT} is busy; using ${port} instead.`);
		}
		const open = options.open ?? args.open;

		const serverModule = await resolveAdminUi(projectRoot);
		const token = randomBytes(32).toString('hex');

		server = await serverModule.startDashboardServer({
			projectRoot,
			token,
			port,
			profile: options.profile ?? args.profile,
			region: options.region ?? args.region,
			allowedOrigins: options.allowOrigins ?? args.allowOrigins,
		});

		const url = buildDashboardUrl(server.url, token);
		console.log(`Blocks dashboard running at ${server.url} (bound to 127.0.0.1)`);
		console.log(url);
		if (open) openDashboardUrl(url);
		console.log('Press Ctrl+C to stop.');
	});

	if (!server) return;
	const runningServer = server;
	await new Promise<void>((resolve) => {
		const stop = async () => {
			await runningServer.close().catch(() => {});
			resolve();
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	});
}
