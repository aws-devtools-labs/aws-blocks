// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PoC demo harness for @aws-blocks/bb-auth-supabase.
 *
 * Defines a real Blocks backend (Scope + ApiNamespace) with one public method
 * (`ping`) and one method gated by `AuthSupabase.requireAuth` (`whoami`), then
 * serves it over HTTP. The per-request `BlocksContext` is constructed exactly
 * as the Blocks dev server does (see packages/core/src/scripts/dev-server.ts:
 * request headers are copied into `context.request.headers`, RPC body is
 * `{ apiNamespace, method, args }` POSTed to `/aws-blocks/api`). This lets a
 * plain `curl` drive the real auth block end-to-end, without the dev server's
 * frontend/vite/proxy machinery.
 *
 * Local HS256 secret is used so the demo runs fully offline.
 */
import { createServer } from 'node:http';
import { Scope, ApiNamespace, ApiError } from '@aws-blocks/core';
import { AuthSupabase } from '@aws-blocks/bb-auth-supabase';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://proj.supabase.co';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? 'demo-supabase-jwt-secret';
const PORT = Number(process.env.PORT ?? 8787);

const scope = new Scope('supabase-demo');
const auth = new AuthSupabase(scope, 'auth', { supabaseUrl: SUPABASE_URL, jwtSecret: JWT_SECRET });

const api = new ApiNamespace(scope, 'api', (context) => ({
	// Public — no auth call, callable by anyone.
	async ping() {
		return { ok: true, message: 'public route, no auth required' };
	},
	// Gated — throws ApiError 401 unless a valid Supabase bearer token is present.
	async whoami() {
		const user = await auth.requireAuth(context);
		return { userId: user.userId, email: user.email, role: user.role };
	},
}));

const server = createServer((req, res) => {
	if (req.method !== 'POST' || (req.url ?? '') !== '/aws-blocks/api') {
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'not found; POST /aws-blocks/api' }));
		return;
	}
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', async () => {
		// Reproduce the dev-server RPC context construction.
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v[0] : v ?? '');
		const responseHeaders = new Headers({ 'content-type': 'application/json' });
		let status = 200;
		const context = {
			request: {
				headers,
				json: async () => JSON.parse(body || '{}'),
				text: async () => body,
				url: new URL(req.url ?? '/aws-blocks/api', `http://${req.headers.host}`),
				params: {},
			},
			response: {
				headers: responseHeaders,
				get status() { return status; },
				set status(c) { status = c; },
				send() {},
			},
		};
		try {
			const { method, args = [] } = JSON.parse(body || '{}');
			const methods = api(context);
			if (typeof methods[method] !== 'function') {
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ ok: false, error: `unknown method '${method}'` }));
				return;
			}
			const result = await methods[method](...args);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true, result }));
		} catch (e) {
			const httpStatus = e instanceof ApiError ? e.status : 500;
			res.writeHead(httpStatus, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: e.message, name: e.name, status: httpStatus }));
		}
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`supabase-demo listening on http://127.0.0.1:${PORT}  (POST /aws-blocks/api)`);
});
