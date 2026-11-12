// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployed, `ctx.request.url.pathname` is the route path: it never carries the
 * API Gateway stage. The URLs `Auth` builds for a request with no public origin
 * configured (the direct engine's `redirect_uri`, the stub IdP's issuer) take
 * the stage from the request's base URL (`getRequestBaseUrl()`), which every
 * transport sets for the request it dispatches.
 */

import assert from 'node:assert';
import type { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { getRequestBaseUrl } from '@aws-blocks/core/bb-utils';
import { appBaseUrl, computeCallbackUrl } from './engines/federation-direct.js';
import { stubIssuerPath, stubIssuerUrl } from './engines/stub-idp-routes.js';

// Importing core registers the per-request base-URL store (test plumbing: the
// transports fill it for every request they dispatch).
void getRequestBaseUrl;
const baseUrlStore = Reflect.get(globalThis, '__BLOCKS_REQUEST_BASE_URL_STORE__') as AsyncLocalStorage<string>;

const GATEWAY = 'https://abc123.execute-api.us-east-1.amazonaws.com';

/** A context for a request to `path` on the gateway: the URL carries the route path only. */
function ctxFor(path: string): BlocksContext {
	return { request: { url: new URL(`${GATEWAY}${path}`) } } as unknown as BlocksContext;
}

describe('URLs Auth builds from the request keep the API Gateway stage', () => {
	const savedOrigin = process.env.BLOCKS_PUBLIC_ORIGIN;
	const savedApiUrl = process.env.BLOCKS_API_URL;
	afterEach(() => {
		if (savedOrigin === undefined) delete process.env.BLOCKS_PUBLIC_ORIGIN;
		else process.env.BLOCKS_PUBLIC_ORIGIN = savedOrigin;
		if (savedApiUrl === undefined) delete process.env.BLOCKS_API_URL;
		else process.env.BLOCKS_API_URL = savedApiUrl;
	});

	test("the direct engine's redirect_uri: the request's base URL, stage included", () => {
		delete process.env.BLOCKS_PUBLIC_ORIGIN;
		const ctx = ctxFor('/aws-blocks/auth/signin/okta');
		baseUrlStore.run(`${GATEWAY}/prod`, () => {
			assert.strictEqual(appBaseUrl(ctx), `${GATEWAY}/prod`);
			assert.strictEqual(computeCallbackUrl(ctx, '/aws-blocks/auth/callback'), `${GATEWAY}/prod/aws-blocks/auth/callback`);
		});
		// A configured public origin still wins.
		process.env.BLOCKS_PUBLIC_ORIGIN = 'https://app.example.com/';
		baseUrlStore.run(`${GATEWAY}/prod`, () => {
			assert.strictEqual(computeCallbackUrl(ctx, '/aws-blocks/auth/callback'), 'https://app.example.com/aws-blocks/auth/callback');
		});
	});

	test("the stub IdP's issuer: the request's base URL, or BLOCKS_API_URL's origin and stage", () => {
		delete process.env.BLOCKS_API_URL;
		const ctx = ctxFor('/aws-blocks/auth/idp/corp/authorize');
		baseUrlStore.run(`${GATEWAY}/prod`, () => {
			assert.strictEqual(stubIssuerUrl('corp', ctx), `${GATEWAY}/prod${stubIssuerPath('corp')}`);
		});
		assert.strictEqual(
			stubIssuerUrl('corp', ctx, `${GATEWAY}/sandbox/aws-blocks/api`),
			`${GATEWAY}/sandbox${stubIssuerPath('corp')}`,
		);
	});
});
