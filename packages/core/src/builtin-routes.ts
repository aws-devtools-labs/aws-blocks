// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { exec } from 'node:child_process';
import { join } from 'node:path';
import type { BlocksContext } from './api.js';
import { getRegisteredRoutes, registerRoute } from './raw-route.js';

function openInEditor(filePath: string): void {
	const platform = process.platform;
	const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start ""' : 'xdg-open';
	exec(`${cmd} "${filePath}"`);
}

/**
 * Register built-in /aws-blocks/resources and /aws-blocks/settings routes.
 * Skips if already registered (safe to call from both CDK and dev server).
 */
export function registerBuiltinRoutes(): void {
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
					const settingsPath = join(process.cwd(), '.bb-data', 'settings.json');
					openInEditor(settingsPath);
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'text/html');
					ctx.response.send(
						`<!DOCTYPE html><html><head><title>Settings</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#1a1a1a}h1{font-size:1.5rem}p{line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:0.9em}a{color:#0066cc}</style></head><body><h1>Settings</h1><p>Opening <code>.bb-data/settings.json</code> in your default editor.</p><p>All AppSetting and Secret values are stored as <code>{ "key": value }</code> entries. Edit and save -- changes take effect on the next <code>get()</code> call.</p><p>File location: <code>${settingsPath}</code></p></body></html>`,
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
