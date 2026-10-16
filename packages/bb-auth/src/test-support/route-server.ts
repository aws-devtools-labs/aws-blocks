// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only: serve the process's registered `RawRoute`s over real HTTP (the
 * way the dev server does), plus a cookie-jar "browser" that follows nothing
 * automatically, so a test can walk a redirect chain hop by hop.
 *
 * @internal
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type BlocksContext, matchRoute } from '@aws-blocks/core';

/** A running route server. */
export interface RouteServer {
	/** `http://127.0.0.1:<port>` */
	origin: string;
	close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString('utf8');
}

/** Start an HTTP server dispatching to the registered RawRoutes (404 when none matches). */
export async function startRouteServer(): Promise<RouteServer> {
	let origin = '';
	const server: Server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? '/', origin);
			const match = matchRoute(req.method ?? 'GET', url.pathname);
			if (!match) {
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('not found');
				return;
			}
			const text = await readBody(req);
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string') headers.set(k, v);
				else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
			}
			let body: unknown = '';
			const responseHeaders = new Headers();
			const ctx: BlocksContext = {
				request: {
					headers,
					body: null,
					json: async () => JSON.parse(text),
					text: async () => text,
					url,
					params: match.params,
				},
				response: {
					headers: responseHeaders,
					status: 200,
					send: (b: unknown) => {
						body = b;
					},
				},
			};
			try {
				await match.route.handler(ctx);
			} catch (e) {
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end(e instanceof Error ? e.message : String(e));
				return;
			}
			const out: Record<string, string | string[]> = {};
			responseHeaders.forEach((v, k) => {
				if (k !== 'set-cookie') out[k] = v;
			});
			const cookies = responseHeaders.getSetCookie();
			if (cookies.length > 0) out['set-cookie'] = cookies;
			const payload = typeof body === 'string' ? body : JSON.stringify(body);
			if (typeof body !== 'string' && !out['content-type']) out['content-type'] = 'application/json';
			res.writeHead(ctx.response.status, out);
			res.end(payload);
		})();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${port}`;
	return {
		origin,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** A cookie jar over `fetch` with `redirect: 'manual'`. */
export class TestBrowser {
	readonly jar = new Map<string, string>();

	cookieHeader(): string {
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
	}

	async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.jar.size > 0) headers.set('cookie', this.cookieHeader());
		const res = await fetch(url, { ...init, headers, redirect: 'manual' });
		for (const line of res.headers.getSetCookie()) {
			const [pair] = line.split(';');
			const eq = pair.indexOf('=');
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			if (/Max-Age=0(?:;|$)/.test(line) || value === '') this.jar.delete(name);
			else this.jar.set(name, value);
		}
		return res;
	}

	/** A `BlocksContext` carrying this browser's cookies, for calling guards directly. */
	context(origin: string): BlocksContext {
		const headers = new Headers({ host: new URL(origin).host });
		if (this.jar.size > 0) headers.set('cookie', this.cookieHeader());
		return {
			request: {
				headers,
				body: null,
				json: async () => ({}),
				text: async () => '',
				url: new URL(`${origin}/aws-blocks/api`),
				params: {},
			},
			response: { headers: new Headers(), status: 200, send: () => {} },
		};
	}
}

/** Resolve a `Location` header against the request URL. */
export function location(res: Response, base: string): string {
	const loc = res.headers.get('location');
	if (!loc) throw new Error(`expected a redirect, got ${res.status}`);
	return new URL(loc, base).toString();
}
