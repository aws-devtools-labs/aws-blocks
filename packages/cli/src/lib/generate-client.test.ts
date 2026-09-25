// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateClientCode } from './generate-client.js';

/**
 * Regression test: generateClientCode collects middleware from whatever
 * the backend registers via registerClientMiddleware(). In sandbox mode,
 * the backend is imported WITHOUT --conditions=aws-runtime, so it registers
 * mock-middleware instead of aws-middleware. The dev server must NOT call
 * generateClientCode in sandbox mode (sandbox.ts already generated the
 * correct client with the aws-runtime condition).
 *
 * This test verifies the mechanism: middleware specifiers registered during
 * backend import appear as imports in the generated client code.
 */

describe('generateClientCode — middleware collection', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `blocks-gen-client-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('includes middleware specifiers registered by the backend', async () => {
		// Create a minimal backend that registers a middleware specifier
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
			globalThis.__BLOCKS_CLIENT_MIDDLEWARE__?.push('@aws-blocks/bb-realtime/aws-middleware');
		`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(
			code.includes("import '@aws-blocks/bb-realtime/aws-middleware'"),
			'Generated client must include aws-middleware when backend registers it',
		);
		assert.ok(
			!code.includes('mock-middleware'),
			'Generated client must NOT include mock-middleware when backend registers aws-middleware',
		);
	});

	it('includes mock-middleware when backend registers it (local dev mode)', async () => {
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
			globalThis.__BLOCKS_CLIENT_MIDDLEWARE__?.push('@aws-blocks/bb-realtime/mock-middleware');
		`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(
			code.includes("import '@aws-blocks/bb-realtime/mock-middleware'"),
			'Generated client must include mock-middleware in local dev mode',
		);
		assert.ok(
			!code.includes('aws-middleware'),
			'Generated client must NOT include aws-middleware in local dev mode',
		);
	});

	it('skips secret()/config() markers — they are values, not API namespaces', async () => {
		// A secret()/config() marker is branded with Symbol.for('@aws-blocks/hosting.ManagedValue');
		// build one inline so the fixture needs no imports. A real export still gets a proxy.
		const backendPath = join(tmpDir, 'backend.mjs');
		writeFileSync(
			backendPath,
			`
				const BRAND = Symbol.for('@aws-blocks/hosting.ManagedValue');
				export const stripeKey = { [BRAND]: true, key: 'STRIPE_KEY', kind: 'secret' };
				export const featureFlags = { [BRAND]: true, key: 'FEATURE_FLAGS', kind: 'config' };
				export function realApi() {}
			`,
		);

		const code = await generateClientCode(backendPath);
		assert.ok(
			!code.includes("__BLOCKS_ApiNamespaceClient__('stripeKey')"),
			'a secret() marker must not become an HTTP namespace',
		);
		assert.ok(
			!code.includes("__BLOCKS_ApiNamespaceClient__('featureFlags')"),
			'a config() marker must not become an HTTP namespace',
		);
		assert.ok(
			code.includes("export const realApi = __BLOCKS_ApiNamespaceClient__('realApi')"),
			'a real (non-marker) export still becomes a namespace',
		);
	});
});
