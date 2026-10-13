// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { getRegisteredRoutes, registerRoute } from './raw-route.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { BlocksContext } from './api.js';

/**
 * Open `filePath` in the OS default app. `execFile` with an argument array — no
 * shell, no string interpolation.
 */
function defaultOpenInEditor(filePath: string): void {
	const onError = () => {};
	if (process.platform === 'darwin') execFile('open', [filePath], onError);
	else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', filePath], onError);
	else execFile('xdg-open', [filePath], onError);
}

let openInEditor: (filePath: string) => void = defaultOpenInEditor;

/** @internal Replace the editor opener (tests only). */
export function _setEditorOpenerForTest(opener: (filePath: string) => void): void {
	openInEditor = opener;
}

export interface BuiltinRoutesOptions {
	/**
	 * `true` only when called by the LOCAL dev server. Enables the convenience of
	 * opening `.bb-data/settings.json` in the developer's editor from
	 * `GET /aws-blocks/settings`. Every other caller — the deployed Lambda, CDK
	 * synth — leaves it unset, so an anonymous GET can never spawn a process
	 * there.
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
					ctx.response.send(`<!DOCTYPE html><html><head><title>Resources</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}p{line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:0.9em}</style></head><body><h1>Resources</h1><p>Locally, each Building Block persists data to <code>.bb-data/</code> in your project root. Tables, buckets, queues, and other state live under <code>.bb-data/{id}/</code>.</p><p>For deployed apps, this page automatically redirects to the Resources group in the AWS console.</p></body></html>`);
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
					const settingsPath = join(process.cwd(), '.bb-data', 'settings.json');
					openInEditor(settingsPath);
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'text/html');
					ctx.response.send(`<!DOCTYPE html><html><head><title>Settings</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}p{line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:0.9em}a{color:#0066cc}</style></head><body><h1>Settings</h1><p>Opening <code>.bb-data/settings.json</code> in your default editor.</p><p>All AppSetting values are stored as <code>{ "fullId": value }</code> entries. Edit and save -- changes take effect on the next <code>get()</code> call.</p><p>File location: <code>${settingsPath}</code></p></body></html>`);
					return;
				}
				ctx.response.status = 302;
				ctx.response.headers.set('Location', url);
				ctx.response.send('');
			},
		},
	];

	for (const route of routes) {
		if (!getRegisteredRoutes().some(r => r.method === route.method && r.path === route.path)) {
			registerRoute(route);
		}
	}
}
