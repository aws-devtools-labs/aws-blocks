// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';

declare global {
	var __BLOCKS_REQUEST_BASE_URL_STORE__: AsyncLocalStorage<string> | undefined;
}

/** The process-wide store: reuse the one another copy registered, else register this one. */
function sharedRequestBaseUrlStore(): AsyncLocalStorage<string> {
	const existing = globalThis.__BLOCKS_REQUEST_BASE_URL_STORE__;
	if (existing) return existing;
	const store = new AsyncLocalStorage<string>();
	globalThis.__BLOCKS_REQUEST_BASE_URL_STORE__ = store;
	return store;
}

/**
 * Per-request store for the request's externally reachable base URL (origin
 * plus API Gateway stage prefix), set by the Lambda handler around dispatch.
 *
 * One store per process, held on `globalThis`: the first copy of
 * `@aws-blocks/core` to load creates it and every later copy reuses it. With a
 * store per copy, a request dispatched by one copy would be invisible to
 * `getRequestBaseUrl()` in another, and the stage would be lost.
 */
export const requestBaseUrl: AsyncLocalStorage<string> = sharedRequestBaseUrlStore();

/**
 * The externally reachable base URL the current request arrived under: the
 * origin plus any API Gateway stage prefix (e.g. `https://abc.execute-api.us-east-1.amazonaws.com/prod`),
 * with no trailing slash. Append a route path to it to build an absolute URL
 * the backend itself can be reached at.
 *
 * `ctx.request.url.pathname` is the route path (the same under `npm run dev`
 * and on AWS), so it never carries the stage. Code that must address the API
 * Gateway endpoint directly, like an issuer URL the Lambda fetches or a
 * callback URL when no front door publishes an origin, needs this base
 * instead of `ctx.request.url.origin`.
 *
 * - Deployed: the request's host and protocol, plus `/{stage}` for a REST API stage.
 * - Sandbox (the dev-server front door): `http://localhost:<port>`, no stage.
 * - Local dev, or outside a request: `ctx.request.url.origin`.
 *
 * Resolves across duplicate copies of `@aws-blocks/core` (see {@link requestBaseUrl}).
 */
export function getRequestBaseUrl(ctx: { request: { url: URL } }): string {
	return requestBaseUrl.getStore() ?? ctx.request.url.origin;
}
