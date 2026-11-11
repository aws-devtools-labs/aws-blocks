// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { BlocksContext } from './api.js';
import { escapeHtml } from './common/escape.js';
import { getRegisteredRoutes, registerRoute } from './raw-route.js';

/**
 * Open `filePath` in the OS default app. `execFile` with an argument array — no
 * shell, no string interpolation.
 *
 * On Windows it starts `explorer.exe` with the path rather than `cmd /c start`:
 * `cmd.exe` re-parses its command line, so a project directory name holding
 * `&` or `|` (and no space, which is when Node leaves the argument unquoted)
 * would split into a second command.
 */
function defaultOpenInEditor(filePath: string): void {
	const onError = () => {};
	if (process.platform === 'darwin') execFile('open', [filePath], onError);
	else if (process.platform === 'win32') execFile('explorer.exe', [filePath], onError);
	else execFile('xdg-open', [filePath], onError);
}

let openInEditor: (filePath: string) => void = defaultOpenInEditor;

/** @internal Replace the editor opener (tests only). */
export function _setEditorOpenerForTest(opener: (filePath: string) => void): void {
	openInEditor = opener;
}

/**
 * The per-request local-dev signal for the settings route: the request comes from
 * the developer, not from another site. A page on another site can make the
 * browser send a GET to the dev server (`<img src="http://localhost:3000/aws-blocks/settings">`),
 * so opening the editor needs, on the request itself:
 *
 * - `Sec-Fetch-Site` absent (a non-browser client), `none` (a typed-in URL or a
 *   bookmark) or `same-origin` (a link in the app). `cross-site` and `same-site`
 *   are refused;
 * - `Origin` absent, or the request's own origin.
 */
function isSameOriginRequest(ctx: BlocksContext): boolean {
	const site = ctx.request.headers.get('sec-fetch-site');
	if (site !== null && site !== 'none' && site !== 'same-origin') return false;
	const origin = ctx.request.headers.get('origin');
	if (origin === null) return true;
	try {
		return new URL(origin).origin === new URL(ctx.request.url).origin;
	} catch {
		return false; // `null` or another value that isn't a URL
	}
}

export interface BuiltinRoutesOptions {
	/**
	 * `true` only when called by the LOCAL dev server. Enables the convenience of
	 * opening `.bb-data/settings.json` in the developer's editor from
	 * `GET /aws-blocks/settings`. Every other caller — the deployed Lambda, CDK
	 * synth — leaves it unset, so an anonymous GET can never spawn a process
	 * there.
	 *
	 * Registration alone doesn't open the editor: each request must also come
	 * from the developer (no cross-site `Sec-Fetch-Site`, no foreign `Origin`), or
	 * it gets a `403` and nothing is opened.
	 */
	localDev?: boolean;
}

/**
 * Register built-in /aws-blocks/resources and /aws-blocks/settings routes.
 * Skips if already registered (safe to call from both CDK and dev server).
 */
export function registerBuiltinRoutes(options: BuiltinRoutesOptions = {}): void {
	const localDev = options.localDev === true;
	const routes: Array<{ method: 'GET' | 'POST'; path: string; handler: (ctx: BlocksContext) => Promise<void> }> = [
		{
			method: 'GET',
			path: '/aws-blocks/resources',
			handler: async (ctx: BlocksContext) => {
				const url = process.env.BB_RESOURCES_GROUP_URL;
				if (!url) {
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'text/html');
					ctx.response.send(
						`<!DOCTYPE html><html><head><title>Resources</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}p{line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:0.9em}</style></head><body><h1>Resources</h1><p>Locally, each Building Block persists data to <code>.bb-data/</code> in your project root. Tables, buckets, queues, and other state live under <code>.bb-data/{id}/</code>.</p><p>For deployed apps, this page automatically redirects to the Resources group in the AWS console.</p></body></html>`,
					);
					return;
				}
				ctx.response.status = 302;
				ctx.response.headers.set('Location', url);
				ctx.response.send('');
			},
		},
		{
			method: 'GET',
			path: '/aws-blocks/settings',
			handler: async (ctx: BlocksContext) => {
				const url = process.env.BB_SETTINGS_GROUP_URL;
				if (!url) {
					if (!localDev) {
						// Deployed without a settings group URL: say so, open nothing, and
						// disclose no filesystem path.
						ctx.response.status = 200;
						ctx.response.headers.set('Content-Type', 'text/html');
						ctx.response.send('<!DOCTYPE html><html><head><title>Settings</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}p{line-height:1.6}</style></head><body><h1>Settings</h1><p>No settings console is configured for this deployment.</p></body></html>');
						return;
					}
					if (!isSameOriginRequest(ctx)) {
						ctx.response.status = 403;
						ctx.response.headers.set('Content-Type', 'text/plain; charset=utf-8');
						ctx.response.send('Forbidden: open /aws-blocks/settings from the app or the address bar.\n');
						return;
					}
					const settingsPath = join(process.cwd(), '.bb-data', 'settings.json');
					openInEditor(settingsPath);
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'text/html');
					ctx.response.send(
						`<!DOCTYPE html><html><head><title>Settings</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}p{line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:0.9em}a{color:#0066cc}</style></head><body><h1>Settings</h1><p>Opening <code>.bb-data/settings.json</code> in your default editor.</p><p>All AppSetting and Secret values are stored as <code>{ "key": value }</code> entries. Edit and save -- changes take effect on the next <code>get()</code> call.</p><p>File location: <code>${escapeHtml(settingsPath)}</code></p></body></html>`,
					);
					return;
				}
				ctx.response.status = 302;
				ctx.response.headers.set('Location', url);
				ctx.response.send('');
			},
		},
	];

	for (const route of routes) {
		if (!getRegisteredRoutes().some((r) => r.method === route.method && r.path === route.path)) {
			registerRoute(route);
		}
	}
}
