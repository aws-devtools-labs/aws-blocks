// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only: play a deployed **API Gateway stage** in-process. While installed,
 * every `fetch` to `<origin>/<stage>/…` — from the test, and from the code
 * under test (the direct engine's discovery, token and JWKS calls) — is
 * dispatched to the process's registered `RawRoute`s the way the Lambda
 * handler does it: the route is matched on the path **without** the stage, and
 * `ctx.request.url` is the full external URL **with** it (core's
 * `buildEventUrl`). Anything else goes to the real `fetch`.
 *
 * So an HTTPS-only engine (the AWS entry) can be driven end to end with no
 * network and no AWS account.
 *
 * @internal
 */

import { type BlocksContext, matchRoute } from '@aws-blocks/core';

/** An installed fake gateway. */
export interface FakeGateway {
	/** `https://<host>/<stage>` — the base every app URL starts with. */
	readonly base: string;
	/** `<base>/aws-blocks/api` — what `LambdaCompute.apiUrl` is for this stage. */
	readonly apiUrl: string;
	/** Requests served, as `METHOD path` (path with the stage). */
	readonly served: string[];
	/** Restore the real `fetch`. */
	uninstall(): void;
}

/** Install a fake gateway at `https://<host>/<stage>`. */
export function installFakeGateway(host = 'gw0test.execute-api.us-east-1.amazonaws.com', stage = 'prod'): FakeGateway {
	const realFetch = globalThis.fetch;
	const base = `https://${host}/${stage}`;
	const served: string[] = [];
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.host !== host || !url.pathname.startsWith(`/${stage}/`)) return realFetch(input, init);
		served.push(`${request.method} ${url.pathname}`);
		const path = url.pathname.slice(stage.length + 1);
		const match = matchRoute(request.method, path);
		if (!match) return new Response('not found', { status: 404 });
		const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
		const headers = new Headers(request.headers);
		headers.set('host', host);
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
			return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
		}
		const payload = typeof body === 'string' ? body : JSON.stringify(body);
		if (typeof body !== 'string' && !responseHeaders.has('content-type')) {
			responseHeaders.set('content-type', 'application/json');
		}
		const status = ctx.response.status;
		return new Response(status === 204 || status === 304 ? null : payload, { status, headers: responseHeaders });
	};
	return {
		base,
		apiUrl: `${base}/aws-blocks/api`,
		served,
		uninstall: () => {
			globalThis.fetch = realFetch;
		},
	};
}
